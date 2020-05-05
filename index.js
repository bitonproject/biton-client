'use strict'

const WebTorrent = require('webtorrent-hybrid')
const debug = require('debug')('biton')
const bitonExtension = require('./biton-ext.js')
const sha1 = require('crypto-js/sha1.js')

const bitonSeed = 'biton'
const infohashPrefix = process.env.INFOHASHPREFIX || ''

/**
 * biton Client
 * @param {Object=} opts
 */
class bitonClient extends WebTorrent {
    constructor (opts={tracker: false, private: true, path: __dirname + './bitondb/'}) {
        super()
        debug('Constructed biton client')
    }

    /**
     * Join a biton swarm
     * @param  {string} swarmSeed
     * @param  {Object=} opts
     * @param  {function=} onseed called when torrent is seeding
     * @return {torrent}
     */
    joinSwarm (swarmSeed, opts, onseed) {
        let combinedSeed = [infohashPrefix, swarmSeed, bitonSeed].filter(Boolean).join(" ");
        let swarmInfohash = sha1(combinedSeed).toString();
        debug('joining biton swarm with swarm seed "%s" and info-hash "%s"', combinedSeed, swarmInfohash)

        let torrent = this.add(swarmInfohash, opts, onseed)

        // Only use the biton extension for torrents that correspond to biton swarms
        torrent.on('wire', function (wire, addr) {
            debug('swarm "%s": connected to peer with address %s', combinedSeed, addr)
            debug('supported extensions: ' + JSON.stringify(wire.peerExtensions))
            wire.use(bitonExtension(wire))
        })
    }

    joinRootSwarm (opts, onseed) {
        this.joinSwarm('', opts, onseed)
    }

    /**
     * Destroy the client, including all torrents and connections to peers.
     * @param  {function} cb
     */
    destroy (cb) {
        super.destroy(cb)
        if (typeof localStorage !== 'undefined') {
            window.localStorage.removeItem('debug')
        }
    }
}


module.exports = bitonClient
