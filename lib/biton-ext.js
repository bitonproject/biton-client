'use strict'

const debug = require('debug')('biton:ext')
const { EventEmitter } = require('events')
const bencode = require('bencode')
const bitonCrypto = require('./crypto')
const Noise = require('./noise')

const extName = 'biton'

const BITFIELD_GROW = 1E3
const METADATA_LENGTH = 1 << 14 // 16 KiB

module.exports = (challengeSeed, localPeerId, identity, identityKeypair, initiator) => {
  class bitonExtension extends EventEmitter {
    constructor (wire) {
      debug('load biton extension on wire with peerId %s', wire.peerId)
      super()

      this._wire = wire
      this.abort = false
      this._passedChallenge = false
      this._challengeSeed = challengeSeed
      this._localPeerId = localPeerId
      this._identity = identity
      this._keypair = identityKeypair
      this.initiator = initiator
      this._noise = new Noise(initiator)

      this.once('noiseReady', this._onNoiseReady)
    }

    onHandshake (infoHash, peerId, extensions) {
      if (this.abort) return

      this._infoHash = infoHash
      this._remotePeerId = peerId
    }

    onExtendedHandshake (handshake) {
      if (this.abort) return

      // TODO Do not expose biton extension on handshake messages
      if (!handshake.m || !handshake.m.biton) {
        return this.emit('warning', new Error('Peer does not support biton'))
      }

      debug('peer %s computing challenges', this._remotePeerId)
      // TODO tie challenges to the IP:PORT of local and remote peers (e.g. as in the DHT "announce" challenge )
      const localChallenge = bitonCrypto.blake2b_256(Uint8Array.from([this._challengeSeed, this._localPeerId,
        this._remotePeerId].join('&')))
      const remoteChallenge = bitonCrypto.blake2b_256(Uint8Array.from([this._challengeSeed, this._remotePeerId,
        this._localPeerId].join('&')))

      this._localChallenge = Buffer.from(localChallenge).toString('base64')
      this._remoteChallenge = Buffer.from(remoteChallenge).toString('base64')

      if (this.initiator) {
        // Initiate Noise XX handshake
        let A
        try {
          A = this._noise._noiseXXMsgA()
        } catch (err) {
          debug('peer %s could not create Noise XX message A, abort: %s', this._remotePeerId, err)
          this.abort = true
          this._noise._destroy()
          return
        }
        const dictSend = { cmd: 'noiseXX', challenge: this._remoteChallenge, A: Buffer.from(A).toString('base64') }
        this._send(dictSend)
      }

    }

    _send(dict)
    {
      const buf = bencode.encode(dict, 'utf-8')
      this._wire.extended(extName, buf)
    }

    /**
     * biton-extension messages are bencoded dictionaries.
     * First message is a challenge to the other party
     *
     * @param {Buffer} buf bencoded PEX dictionary
     */
    onMessage (buf) {
      if (this.abort) {
        debug('peer %s sent a message to biton-ext after abort; dropping message')
        return
      }

      let dictRecv
      try {
        dictRecv = bencode.decode(buf, 'utf-8')
        debug('peer %s sent message: %s', this._remotePeerId, JSON.stringify(dictRecv))
      } catch (err) {
        // Drop invalid messages
        debug('peer %s sent invalid message: %s', this._remotePeerId, err)
        return
      }
      if (dictRecv.cmd) {
        switch (dictRecv) {
          case 'ping':
            debug('peer %s sent ping', this._remotePeerId)
            this.emit('ping')
            break
          case 'noiseXX':
            this._handleNoiseHandshakeMsg(dictRecv)
            return
        }
      }
      if (dictRecv.noiseMsg && this._noise.isSplit) {
        try {
          const decNoiseMsg = this._noise._recvDec(Buffer.from(dictRecv.noiseMsg, 'utf-8'))
          console.log('peer %s sent noise message: %s', this._remotePeerId, Buffer.from(decNoiseMsg).toString())
          this.emit('recvMsg')
        } catch (err) {
          debug('peer %s sent invalid noise message %s', this._remotePeerId, err)
        }
      }
    }

    _handleNoiseHandshakeMsg(dictRecv)
    {
      if (!this._passedChallenge) {
        // Noise_XX Handshake A and B messages

        if (!dictRecv.challenge || dictRecv.challenge !== this._localChallenge) {
          debug('peer %s sent invalid challenge message during handshake, abort', this._remotePeerId)
          this.abort = true
          this._noise._destroy()
          return
        }

        debug('peer %s succeeded in our challenge', this._remotePeerId)
        if (!this.initiator) {
          // received message A
          let B
          try {
            B = this._noise._noiseXXMsgB(Buffer.from(dictRecv.A, 'base64'))
          } catch (err) {
            debug('peer %s could not create Noise_XX message A, abort: %s', this._remotePeerId, err)
            this.abort = true
            this._noise._destroy()
            return
          }
          // Send challenge and message B [e, ee, s, es]
          const dictSend = { cmd: 'noiseXX', challenge: this._remoteChallenge, B: Buffer.from(B).toString('base64') }
          this._send(dictSend)
        } else {
          // received message B
          let C
          try {
            C = this._noise._noiseXXMsgC(Buffer.from(dictRecv.B, 'base64'))
          } catch (err) {
            debug('peer %s sent invalid Noise_XX message B, abort: %s', this._remotePeerId, err)
            this.abort = true
            this._noise._destroy()
            return
          }
          const dictSend = { cmd: 'noiseXX', C: Buffer.from(C).toString('base64') }
          this._send(dictSend)
          this.emit('noiseReady')
        }
        this._passedChallenge = true
      } else {
        // received message C
        try {
          this._noise._noiseXXMsgD(Buffer.from(dictRecv.C, 'base64'))
          this.emit('noiseReady')
        } catch (err) {
          debug('peer %s sent invalid Noise_XX message C, abort: %s', this._remotePeerId, err)
          this.abort = true
          this._noise._destroy()
          return
        }
      }
    }

    _onNoiseReady () {
      debug('peer %s noise ready', this._remotePeerId)
    }

    sendPing () {
      this._send({ cmd: 'ping' })
    }

    sendEnc (buf) {
      const noiseMsg = this._noise._sendEnc(buf)
      this._send({ noiseMsg: Buffer.from(noiseMsg).toString('utf-8') })
    }

  }

  // Name of the bittorrent-protocol extension
  bitonExtension.prototype.name = extName

  return bitonExtension
}
