const net = require('net')
const utp = require('utp-native')
const os = require('os')
const Nat = require('./nat')
const Payload = require('./secure-payload')
const SocketWrap = require('./socket-wrap')
const Sleeper = require('./sleeper')

const SERVER_CONNECTION_TIMEOUT = 6000
const INITIAL_PAIRING_TIMEOUT = 10000
const BIRTHDAY_SOCKETS = 256
const HOLEPUNCH = Buffer.from([0])
const HOLEPUNCH_TTL = 5
const DEFAULT_TTL = 64
const MAX_REOPENS = 3

class Pair {
  constructor (sockets, handshake) {
    this.handshake = handshake
    this.socket = null
    this.nat = null
    this.payload = null

    // events
    this.onconnection = noop
    this.ondestroy = noop

    // conditions
    this.destroyed = false
    this.punching = false
    this.connected = false

    // track remote state
    this.remoteNat = 0
    this.remoteHolepunching = false
    this.remoteAddress = null
    this.remoteVerified = false

    this._timeout = setTimeout(destroy, INITIAL_PAIRING_TIMEOUT, this)
    this._sleeper = null
    this._reopening = null
    this._started = null
    this._sockets = sockets
    this._allSockets = []
    this._onutpconnectionbound = null
    this._onmessagebound = null
  }

  open () {
    if (this.socket) return this.socket

    const self = this
    const dht = this._sockets.dht

    this.payload = new Payload(this.handshake.hash)

    this._sleeper = new Sleeper()
    this._onmessagebound = onmessage
    this._onutpconnectionbound = onconnection
    this._reset()

    function onconnection (rawSocket) {
      self._onutpconnection(this, rawSocket)
    }

    function onmessage (buf, rinfo) {
      if (buf.byteLength > 1 && this === self.socket) dht.onmessage(this, buf, rinfo)
      else self._onmessage(this, buf, rinfo)
    }

    return this.socket
  }

  async reopen () {
    if (!this._reopening) this._reopening = this._reopen()
    await this._reopening
    return this.nat.type === 1
  }

  async _reopen () {
    for (let i = 0; this.nat.type >= 2 && i < MAX_REOPENS && !this.destroyed; i++) {
      console.log('bad looking socket... try reopening it')
      this._reset()
      await this.nat.analyzing
      console.log('after reroll... nat=', this.nat.type)
    }
  }

  ping (addr, socket = this.socket) {
    return holepunch(socket, addr, false)
  }

  openSession (addr, socket = this.socket) {
    return holepunch(socket, addr, true)
  }

  punch () {
    if (!this._punching) this._punching = this._punch()
    return this._punching
  }

  async _punch () {
    if (this.destroyed) return
    this.punching = true

    clearTimeout(this._timeout)
    this._timeout = null

    // Note that most of these async functions are meant to run in the background
    // which is why we don't await them here and why they are not allowed to throw

    if (this.nat.type === 1 && this.remoteNat === 1) {
      this._consistentProbe()
    } else if (this.nat.type === 1 && this.remoteNat >= 2) {
      this._randomProbes()
    } else if (this.nat.type >= 2 && this.remoteNat === 1) {
      await this._openBirthdaySockets()
      if (this.punching) this._keepAliveRandomNat()
    }
  }

  async _consistentProbe () {
    // Here we do the sleep first because the "fast open" mode in the server just fired a ping
    if (!this.handshake.isInitiator) await this._sleeper.pause(1000)

    let tries = 10

    while (this.punching && tries-- > 0) {
      await holepunch(this.socket, this.remoteAddress, false)
      if (this.punching) await this._sleeper.pause(1000)
    }

    this._autoDestroy()
  }

  _autoDestroy () {
    if (this.connected || this._timeout) return
    this.destroy()
  }

  // Note that this never throws so it is safe to run in the background
  async _randomProbes () {
    let tries = 1750 // ~35s

    while (this.punching && tries-- > 0) {
      const addr = { host: this.remoteAddress.host, port: randomPort() }
      await holepunch(this.socket, addr, false)
      if (this.punching) await this._sleeper.pause(20)
    }

    this._autoDestroy()
  }

  // Note that this never throws so it is safe to run in the background
  async _keepAliveRandomNat () {
    let i = 0
    let lowTTLRounds = 1

    // TODO: experiment with this here. We just bursted all the messages in
    // openOtherSockets to ensure the sockets are open, so it's potentially
    // a good idea to slow down for a bit.
    await this._sleeper.pause(100)

    let tries = 1750 // ~35s

    while (this.punching && tries-- > 0) {
      if (i === this._allSockets.length) {
        i = 0
        if (lowTTLRounds > 0) lowTTLRounds--
      }

      await holepunch(this._allSockets[i++], this.remoteAddress, lowTTLRounds > 0)
      if (this.punching) await this._sleeper.pause(20)
    }

    this._autoDestroy()
  }

  async _openBirthdaySockets () {
    while (this.punching && this._allSockets.length < BIRTHDAY_SOCKETS) {
      const socket = this._makeSocket()
      this._allSockets.push(socket)
      await holepunch(socket, this.remoteAddress, HOLEPUNCH_TTL)
    }
  }

  _ontcpconnection (rawSocket, data, ended) {
    if (this.connected) {
      rawSocket.on('error', noop)
      rawSocket.destroy()
      return
    }

    this.connected = true
    this._shutdown(null)

    this.onconnection(rawSocket, data, ended, this.handshake)
  }

  _onutpconnection (utp, rawSocket) {
    if (this.connected) {
      rawSocket.on('error', noop)
      rawSocket.destroy()
      return
    }

    utp.firewall(true)

    this.connected = true
    this._shutdown(this._findWrap(utp))

    this.onconnection(rawSocket, null, false, this.handshake)
  }

  _shutdown (skip) {
    if (this._timeout) clearTimeout(this._timeout)
    this._timeout = null

    if (this.nat) this.nat.destroy()
    this.punching = false

    for (const socket of this._allSockets) {
      if (socket === skip) continue
      socket.close()
    }
    if (skip) this._allSockets[0] = skip
    const len = skip ? 1 : 0
    while (this._allSockets.length > len) this._allSockets.pop()

    // If we are waiting for a connection - ie a non destructive shutdown
    // without a current connecion, set the server timeout...
    if (!this.destroyed && !this.connected) {
      this._timeout = setTimeout(destroy, SERVER_CONNECTION_TIMEOUT, this)
    }

    if (this._sleeper) this._sleeper.resume()
  }

  // Note that this never throws so it is safe to run in the background
  async _onmessage (socket, buf, rinfo) {
    // TODO: try to filter out spoofed messages, but remoteAddress is not always set
    // so skipping for now.

    // make sure we only hit this path if we are punching (shutdown clear this bool)
    if (!this.punching) return

    this._shutdown(socket)

    if (this.handshake.isInitiator) {
      const utp = socket.unwrap()
      const c = utp.connect(rinfo.port, rinfo.address)
      this._onutpconnection(utp, c)
      return
    }

    // Switch to slow pings to the other side, until they ping us back
    // with a connection
    while (!this.destroyed && !this.connected) {
      await holepunch(socket, { host: rinfo.address, port: rinfo.port }, false)
      if (!this.destroyed && !this.connected) await this._sleeper.pause(1000)
    }
  }

  _findWrap (utp) {
    for (const wrap of this._allSockets) {
      if (wrap.socket === utp) return wrap
    }
    throw new Error('Wrap not found')
  }

  _makeSocket () {
    const socket = utp()
    socket.bind(0)
    socket.on('connection', this._onutpconnectionbound)
    if (!this.handshake.isInitiator) socket.firewall(false)
    const wrap = new SocketWrap(socket, DEFAULT_TTL)
    wrap.on('message', this._onmessagebound)
    return wrap
  }

  _reset () {
    if (this.socket) {
      // we should never hit this condition, but just to assert if we do...
      if (this._allSockets.length > 1) {
        throw new Error('Can only reset a single socket')
      }
      this.socket.close()
      this._allSockets.pop()
    }

    this.socket = this._makeSocket()
    this._allSockets.push(this.socket)

    this.nat = new Nat(this._sockets.dht, this.socket)

    // TODO: maybe make auto sampling configurable somehow?
    this.nat.autoSample()
  }

  connect (addr) {
    const rawSocket = net.connect(addr.port, addr.host)
    this._ontcpconnection(rawSocket, null, false)
    return rawSocket
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true

    this._shutdown(null)
    this.ondestroy()

    const i = this._sockets._pairs.indexOf(this)
    if (i === -1) return
    this._sockets._pairs[i] = this._sockets._pairs[this._sockets._pairs.length - 1]
    this._sockets._pairs.pop()
  }
}

module.exports = class SocketPairer {
  constructor (dht, server) {
    this.dht = dht

    this._server = server
    this._server.on('connection', this.onconnection.bind(this))
    this._pairs = []
    this._incoming = []
  }

  _notify (inc) {
    for (let i = 0; i < this._pairs.length; i++) {
      const p = this._pairs[i]
      if (!p.handshake.remoteId.equals(inc.id)) continue

      this._pairs[i] = this._pairs[this._pairs.length - 1]
      this._pairs.pop()

      const { rawSocket, data, ended } = this._finalize(inc)
      p._ontcpconnection(rawSocket, data, ended)
      return
    }

    this._incoming.push(inc)
  }

  _addPair (p) {
    for (let i = 0; i < this._incoming.length; i++) {
      const inc = this._incoming[i]
      if (!inc.id.equals(p.handshake.remoteId)) continue

      this._incoming[i] = this._incoming[this._incoming.length - 1]
      this._incoming.pop()

      if (p.destroyed || p.connected) {
        inc.onclose()
        return
      }

      const { rawSocket, data, ended } = this._finalize(inc)
      p._ontcpconnection(rawSocket, data, ended)
      return
    }

    if (p.destroyed || p.connected) return
    this._pairs.push(p)
  }

  _finalize (inc) {
    clearTimeout(inc.timeout)
    inc.timeout = null

    inc.rawSocket.removeListener('readable', inc.onreadable)
    inc.rawSocket.removeListener('end', inc.onend)
    inc.rawSocket.removeListener('error', inc.onclose)
    inc.rawSocket.removeListener('close', inc.onclose)

    return inc
  }

  onconnection (rawSocket) {
    const self = this

    const inc = {
      id: null,
      rawSocket,
      data: null,
      ended: false,
      onreadable,
      onclose,
      onend,
      timeout: null
    }

    inc.timeout = setTimeout(onclose, SERVER_CONNECTION_TIMEOUT)

    rawSocket.on('readable', onreadable)
    rawSocket.on('end', onend)
    rawSocket.on('error', onclose)
    rawSocket.on('close', onclose)

    function onclose () {
      self._finalize(inc)

      rawSocket.on('error', noop)
      rawSocket.destroy()

      if (!inc.id) return
      const i = self._incoming.indexOf(inc)
      if (i === -1) return
      self._incoming[i] = self._incoming[self._incoming.length - 1]
      self._incoming.pop()
    }

    function onend () {
      inc.ended = true
    }

    function onreadable () {
      const next = rawSocket.read()
      inc.data = inc.data ? Buffer.concat([next, inc.data]) : next

      if (inc.data.byteLength < 35) { // 3 byte prefix + 32 id
        return
      }

      rawSocket.removeListener('readable', onreadable)
      inc.id = inc.data.subarray(3, 35)

      self._notify(inc)
    }
  }

  pair (handshake) {
    const p = new Pair(this, handshake)
    // Add it NT to give the user a chance to add listeners
    process.nextTick(addPunchNT, p)
    return p
  }

  remoteServerAddress () {
    const port = this._server.address().port

    if (!this.dht.host) return null
    if (!this.dht.port) return null
    if (this.dht.firewalled) return null
    if (port !== this.dht.port) return null

    return {
      host: this.dht.host,
      port
    }
  }

  localServerAddress () {
    return {
      host: localIP(), // we should cache this i think for some time / based on some heuristics...
      port: this._server.address().port
    }
  }
}

function localIP () {
  const nets = os.networkInterfaces()
  for (const n of Object.keys(nets)) {
    for (const i of nets[n]) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
}

function holepunch (socket, addr, lowTTL) {
  return new Promise((resolve) => {
    socket.sendTTL(lowTTL ? HOLEPUNCH_TTL : DEFAULT_TTL, HOLEPUNCH, 0, 1, addr.port, addr.host, (err) => {
      resolve(!err)
    })
  })
}

function randomPort () {
  return 1000 + (Math.random() * 64536) | 0
}

function noop () {}

function addPunchNT (p) {
  p._sockets._addPair(p)
}

function destroy (p) {
  p.destroy()
}