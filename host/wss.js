// Minimal RFC 6455 WebSocket server for the Browser Annotate bridge.
//
// Why hand-rolled: the extension half must reach the DSH host over a long-lived
// bidirectional socket, and this plugin deliberately ships ZERO npm
// dependencies so `dsh plugin add` never touches the profile's pnpm tree (and
// therefore never trips pnpm's running-app guard or build-script policy).
// A full WS library is not needed: this bridge carries small JSON control
// frames plus base64 PNG/JPEG screenshot payloads, one client at a time.
//
// Scope: server-side only, no extensions, no permessage-deflate, no
// subprotocols. Fragmented text messages are reassembled; control frames are
// handled at their boundaries per RFC 6455 §5.5.

import { createHash } from 'node:crypto'

/** RFC 6455 §1.3: the fixed GUID appended to the client key before hashing. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Hard ceiling on one reassembled message. Screenshots dominate this budget. */
const MAX_MESSAGE_BYTES = 24 * 1024 * 1024

/** Frame opcodes (RFC 6455 §5.2). */
const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/**
 * Compute the `Sec-WebSocket-Accept` value for a client's key.
 * @param key - the raw `Sec-WebSocket-Key` header value.
 * @returns the base64 SHA-1 digest the handshake response must carry.
 */
export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/**
 * Decide whether one upgrade request is a valid WebSocket handshake.
 * @param req - the HTTP upgrade request.
 * @returns true when the request carries a usable `Sec-WebSocket-Key` and asks to upgrade.
 */
export function isWebSocketUpgrade(req) {
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
  return upgrade === 'websocket' && typeof req.headers['sec-websocket-key'] === 'string'
}

/**
 * Write one WebSocket frame. Server frames are never masked (RFC 6455 §5.1),
 * so the header is 2 bytes plus an extended length when the payload is large.
 * @param socket - the upgraded duplex socket.
 * @param opcode - the frame opcode.
 * @param payload - the frame body.
 */
export function writeFrame(socket, opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8')
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    // Payloads above 4 GiB cannot occur here; the high word stays zero.
    header.writeUInt32BE(Math.floor(length / 4294967296), 2)
    header.writeUInt32BE(length >>> 0, 6)
  }
  header[0] = 0x80 | opcode
  socket.write(Buffer.concat([header, body]))
}

/** One accepted WebSocket connection. */
export class WsConnection {
  /**
   * @param socket - the upgraded duplex socket.
   * @param onMessage - invoked with each complete text message.
   * @param onClose - invoked once when the connection ends.
   */
  constructor(socket, onMessage, onClose) {
    this.socket = socket
    this.onMessage = onMessage
    this.onClose = onClose
    this.closed = false
    this.buffer = Buffer.alloc(0)
    /** Opcode of the message currently being reassembled, or null between messages. */
    this.fragmentOpcode = null
    this.fragments = []
    this.fragmentBytes = 0
    this.socket.on('data', chunk => this.#consume(chunk))
    this.socket.on('error', () => this.close())
    this.socket.on('close', () => this.#finish())
  }

  /**
   * Send one text message. A closed connection drops the write silently: the
   * bridge treats a vanished extension as a disconnect, not an error.
   * @param text - the JSON payload to send.
   */
  send(text) {
    if (this.closed) return
    try {
      writeFrame(this.socket, OP_TEXT, text)
    } catch {
      this.close()
    }
  }

  /** Close the connection and release its socket. */
  close() {
    if (this.closed) return
    this.closed = true
    try {
      writeFrame(this.socket, OP_CLOSE, Buffer.alloc(0))
    } catch {
      // The peer is already gone; the destroy below is the real cleanup.
    }
    try {
      this.socket.destroy()
    } catch {
      // Already destroyed.
    }
    this.#finish()
  }

  /**
   * Feed bytes that arrived together with the handshake. The `head` buffer of
   * an `upgrade` event is part of the frame stream, not the HTTP request, so it
   * is consumed through the same path as later socket data.
   * @param chunk - the trailing bytes from the upgrade event.
   */
  consumeInitial(chunk) {
    if (this.closed) return
    this.#consume(chunk)
  }

  /** Run the close callback exactly once. */
  #finish() {
    if (this.finished) return
    this.finished = true
    try {
      this.onClose()
    } catch {
      // A listener fault must not escape the socket event loop.
    }
  }

  /**
   * Append socket bytes and drain every complete frame they contain.
   * @param chunk - the newly arrived socket bytes.
   */
  #consume(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.#readFrame()
      if (frame === null) return
      this.#handleFrame(frame)
      if (this.closed) return
    }
  }

  /**
   * Parse one frame off the head of the buffer.
   * @returns the parsed frame, or null when more bytes are needed.
   */
  #readFrame() {
    const buf = this.buffer
    if (buf.length < 2) return null
    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let length = buf[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < offset + 2) return null
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return null
      const high = buf.readUInt32BE(offset)
      const low = buf.readUInt32BE(offset + 4)
      length = high * 4294967296 + low
      offset += 8
    }
    if (length > MAX_MESSAGE_BYTES) {
      // Refusing an oversized frame is a protocol close, not a partial read.
      this.close()
      return null
    }
    let maskKey = null
    if (masked) {
      if (buf.length < offset + 4) return null
      maskKey = buf.subarray(offset, offset + 4)
      offset += 4
    }
    if (buf.length < offset + length) return null
    const payload = Buffer.from(buf.subarray(offset, offset + length))
    if (maskKey !== null) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
    }
    this.buffer = buf.subarray(offset + length)
    return { fin, opcode, payload }
  }

  /**
   * Act on one complete frame: control frames immediately, data frames through
   * the fragment assembler.
   * @param frame - the parsed frame.
   */
  #handleFrame(frame) {
    const { fin, opcode, payload } = frame
    if (opcode === OP_CLOSE) {
      this.close()
      return
    }
    if (opcode === OP_PING) {
      if (!this.closed) writeFrame(this.socket, OP_PONG, payload)
      return
    }
    if (opcode === OP_PONG) return
    if (opcode === OP_CONTINUATION) {
      if (this.fragmentOpcode === null) {
        this.close()
        return
      }
      this.fragments.push(payload)
      this.fragmentBytes += payload.length
    } else {
      if (this.fragmentOpcode !== null) {
        this.close()
        return
      }
      this.fragmentOpcode = opcode
      this.fragments = [payload]
      this.fragmentBytes = payload.length
    }
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
      this.close()
      return
    }
    if (!fin) return
    const complete = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)
    const wasText = this.fragmentOpcode === OP_TEXT
    this.fragmentOpcode = null
    this.fragments = []
    this.fragmentBytes = 0
    if (!wasText) return
    try {
      this.onMessage(complete.toString('utf8'))
    } catch {
      // A message-handler fault closes the connection rather than the process.
      this.close()
    }
  }
}

/**
 * Complete a WebSocket handshake and attach a {@link WsConnection}.
 * @param req - the HTTP upgrade request.
 * @param socket - the raw duplex socket from the upgrade event.
 * @param head - bytes already read past the request headers.
 * @param onMessage - invoked with each complete text message.
 * @param onClose - invoked once when the connection ends.
 * @returns the live connection, or null when the request is not a valid handshake.
 */
export function acceptUpgrade(req, socket, head, onMessage, onClose) {
  if (!isWebSocketUpgrade(req)) {
    socket.destroy()
    return null
  }
  const key = req.headers['sec-websocket-key']
  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ].join('\r\n')
  socket.write(response)
  socket.setNoDelay(true)
  const connection = new WsConnection(socket, onMessage, onClose)
  // Bytes that arrived with the handshake belong to the frame stream.
  if (head !== undefined && head.length > 0) connection.consumeInitial(head)
  return connection
}
