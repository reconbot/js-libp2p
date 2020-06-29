'use strict'
/* eslint-env mocha */

const chai = require('chai')
chai.use(require('dirty-chai'))
chai.use(require('chai-as-promised'))
const { expect } = chai
const sinon = require('sinon')

const { EventEmitter } = require('events')
const delay = require('delay')
const PeerId = require('peer-id')
const duplexPair = require('it-pair/duplex')
const multiaddr = require('multiaddr')
const pWaitFor = require('p-wait-for')

const { codes: Errors } = require('../../src/errors')
const { IdentifyService, multicodecs } = require('../../src/identify')
const Peers = require('../fixtures/peers')
const Libp2p = require('../../src')
const PeerStore = require('../../src/peer-store')
const baseOptions = require('../utils/base-options.browser')

const { MULTIADDRS_WEBSOCKETS } = require('../fixtures/browser')
const remoteAddr = MULTIADDRS_WEBSOCKETS[0]
const listenMaddrs = [multiaddr('/ip4/127.0.0.1/tcp/15002/ws')]

const protocols = new Map([
  [multicodecs.IDENTIFY, () => { }],
  [multicodecs.IDENTIFY_PUSH, () => { }]
])

const protocolsLegacy = new Map([
  [multicodecs.IDENTIFY_1_0_0, () => { }],
  [multicodecs.IDENTIFY_PUSH_1_0_0, () => { }]
])

describe('Identify', () => {
  let localPeer
  let remotePeer

  before(async () => {
    [localPeer, remotePeer] = (await Promise.all([
      PeerId.createFromJSON(Peers[0]),
      PeerId.createFromJSON(Peers[1])
    ]))
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should be able to identify another peer with 1.0.0 legacy protocol', async () => {
    const localIdentify = new IdentifyService({
      libp2p: {
        peerId: localPeer,
        connectionManager: new EventEmitter(),
        peerStore: new PeerStore(),
        multiaddrs: listenMaddrs
      },
      protocols: protocolsLegacy
    })

    const remoteIdentify = new IdentifyService({
      libp2p: {
        peerId: remotePeer,
        connectionManager: new EventEmitter(),
        peerStore: new PeerStore(),
        multiaddrs: listenMaddrs
      },
      protocols: protocolsLegacy
    })

    const observedAddr = multiaddr('/ip4/127.0.0.1/tcp/1234')
    const localConnectionMock = { newStream: () => { }, remotePeer }
    const remoteConnectionMock = { remoteAddr: observedAddr }

    const [local, remote] = duplexPair()
    sinon.stub(localConnectionMock, 'newStream').returns({ stream: local, protocol: multicodecs.IDENTIFY_1_0_0 })

    sinon.spy(localIdentify.peerStore.addressBook, 'set')
    sinon.spy(localIdentify.peerStore.protoBook, 'set')

    // Run identify
    await Promise.all([
      localIdentify.identify(localConnectionMock),
      remoteIdentify.handleMessage({
        connection: remoteConnectionMock,
        stream: remote,
        protocol: multicodecs.IDENTIFY_1_0_0
      })
    ])

    expect(localIdentify.peerStore.addressBook.set.callCount).to.equal(1)
    expect(localIdentify.peerStore.protoBook.set.callCount).to.equal(1)

    // Validate the remote peer gets updated in the peer store
    const call = localIdentify.peerStore.addressBook.set.firstCall
    expect(call.args[0].id.bytes).to.equal(remotePeer.bytes)
    expect(call.args[1]).to.exist()
    expect(call.args[1]).have.lengthOf(listenMaddrs.length)
    expect(call.args[1][0].equals(listenMaddrs[0]))
  })

  it('should be able to identify another peer', async () => {
    const localIdentify = new IdentifyService({
      libp2p: {
        peerId: localPeer,
        connectionManager: new EventEmitter(),
        peerStore: new PeerStore(),
        multiaddrs: listenMaddrs
      },
      protocols
    })

    const remoteIdentify = new IdentifyService({
      libp2p: {
        peerId: remotePeer,
        connectionManager: new EventEmitter(),
        peerStore: new PeerStore(),
        multiaddrs: listenMaddrs
      },
      protocols
    })

    const observedAddr = multiaddr('/ip4/127.0.0.1/tcp/1234')
    const localConnectionMock = { newStream: () => {}, remotePeer }
    const remoteConnectionMock = { remoteAddr: observedAddr }

    const [local, remote] = duplexPair()
    sinon.stub(localConnectionMock, 'newStream').returns({ stream: local, protocol: multicodecs.IDENTIFY })

    sinon.spy(localIdentify.peerStore.addressBook, 'consumePeerRecord')
    sinon.spy(localIdentify.peerStore.protoBook, 'set')

    // Run identify
    await Promise.all([
      localIdentify.identify(localConnectionMock),
      remoteIdentify.handleMessage({
        connection: remoteConnectionMock,
        stream: remote,
        protocol: multicodecs.IDENTIFY
      })
    ])

    expect(localIdentify.peerStore.addressBook.consumePeerRecord.callCount).to.equal(1)
    expect(localIdentify.peerStore.protoBook.set.callCount).to.equal(1)

    // Validate the remote peer gets updated in the peer store
    const addresses = localIdentify.peerStore.addressBook.get(remotePeer)
    expect(addresses).to.exist()
    expect(addresses).have.lengthOf(listenMaddrs.length)
    expect(addresses.map((a) => a.multiaddr)[0].equals(listenMaddrs[0]))
    expect(addresses.map((a) => a.isCertified)[0]).to.eql(true)
  })

  it('should throw if identified peer is the wrong peer', async () => {
    const localIdentify = new IdentifyService({
      libp2p: {
        peerId: localPeer,
        connectionManager: new EventEmitter(),
        peerStore: new PeerStore(),
        multiaddrs: []
      },
      protocols
    })
    const remoteIdentify = new IdentifyService({
      libp2p: {
        peerId: remotePeer,
        connectionManager: new EventEmitter(),
        peerStore: new PeerStore(),
        multiaddrs: []
      },
      protocols
    })

    const observedAddr = multiaddr('/ip4/127.0.0.1/tcp/1234')
    const localConnectionMock = { newStream: () => {}, remotePeer: localPeer }
    const remoteConnectionMock = { remoteAddr: observedAddr }

    const [local, remote] = duplexPair()
    sinon.stub(localConnectionMock, 'newStream').returns({ stream: local, protocol: multicodecs.IDENTIFY })

    // Run identify
    const identifyPromise = Promise.all([
      localIdentify.identify(localConnectionMock, localPeer),
      remoteIdentify.handleMessage({
        connection: remoteConnectionMock,
        stream: remote,
        protocol: multicodecs.IDENTIFY
      })
    ])

    await expect(identifyPromise)
      .to.eventually.be.rejected()
      .and.to.have.property('code', Errors.ERR_INVALID_PEER)
  })

  describe('push', () => {
    it('should be able to push identify updates to another peer with 1.0.0 legacy protocols', async () => {
      const connectionManager = new EventEmitter()
      connectionManager.getConnection = () => {}

      const localIdentify = new IdentifyService({
        libp2p: {
          peerId: localPeer,
          connectionManager: new EventEmitter(),
          peerStore: new PeerStore(),
          multiaddrs: listenMaddrs
        },
        protocols: new Map([
          [multicodecs.IDENTIFY_1_0_0],
          [multicodecs.IDENTIFY_PUSH_1_0_0],
          ['/echo/1.0.0']
        ])
      })
      const remoteIdentify = new IdentifyService({
        libp2p: {
          peerId: remotePeer,
          connectionManager,
          peerStore: new PeerStore(),
          multiaddrs: []
        }
      })

      // Setup peer protocols and multiaddrs
      const localProtocols = new Set([multicodecs.IDENTIFY_1_0_0, multicodecs.IDENTIFY_PUSH_1_0_0, '/echo/1.0.0'])
      const localConnectionMock = { newStream: () => {} }
      const remoteConnectionMock = { remotePeer: localPeer }

      const [local, remote] = duplexPair()
      sinon.stub(localConnectionMock, 'newStream').returns({ stream: local, protocol: multicodecs.IDENTIFY_PUSH_1_0_0 })

      sinon.spy(remoteIdentify.peerStore.addressBook, 'consumePeerRecord')
      sinon.spy(remoteIdentify.peerStore.protoBook, 'set')

      // Run identify
      await Promise.all([
        localIdentify.push([localConnectionMock]),
        remoteIdentify.handleMessage({
          connection: remoteConnectionMock,
          stream: remote,
          protocol: multicodecs.IDENTIFY_PUSH_1_0_0
        })
      ])

      expect(remoteIdentify.peerStore.addressBook.consumePeerRecord.callCount).to.equal(1)
      expect(remoteIdentify.peerStore.protoBook.set.callCount).to.equal(1)

      const addresses = localIdentify.peerStore.addressBook.get(localPeer)
      expect(addresses).to.exist()
      expect(addresses).have.lengthOf(listenMaddrs.length)
      expect(addresses.map((a) => a.multiaddr)).to.eql(listenMaddrs)

      const [peerId2, protocols] = remoteIdentify.peerStore.protoBook.set.firstCall.args
      expect(peerId2.bytes).to.eql(localPeer.bytes)
      expect(protocols).to.eql(Array.from(localProtocols))
    })

    it('should be able to push identify updates to another peer', async () => {
      const connectionManager = new EventEmitter()
      connectionManager.getConnection = () => { }

      const localIdentify = new IdentifyService({
        libp2p: {
          peerId: localPeer,
          connectionManager: new EventEmitter(),
          peerStore: new PeerStore(),
          multiaddrs: listenMaddrs
        },
        protocols: new Map([
          [multicodecs.IDENTIFY],
          [multicodecs.IDENTIFY_PUSH],
          ['/echo/1.0.0']
        ])
      })
      const remoteIdentify = new IdentifyService({
        libp2p: {
          peerId: remotePeer,
          connectionManager,
          peerStore: new PeerStore(),
          multiaddrs: []
        }
      })

      // Setup peer protocols and multiaddrs
      const localProtocols = new Set([multicodecs.IDENTIFY, multicodecs.IDENTIFY_PUSH, '/echo/1.0.0'])
      const localConnectionMock = { newStream: () => { } }
      const remoteConnectionMock = { remotePeer: localPeer }

      const [local, remote] = duplexPair()
      sinon.stub(localConnectionMock, 'newStream').returns({ stream: local, protocol: multicodecs.IDENTIFY_PUSH })

      sinon.spy(remoteIdentify.peerStore.addressBook, 'consumePeerRecord')
      sinon.spy(remoteIdentify.peerStore.protoBook, 'set')

      // Run identify
      await Promise.all([
        localIdentify.push([localConnectionMock]),
        remoteIdentify.handleMessage({
          connection: remoteConnectionMock,
          stream: remote,
          protocol: multicodecs.IDENTIFY_PUSH
        })
      ])

      expect(remoteIdentify.peerStore.addressBook.consumePeerRecord.callCount).to.equal(1)
      expect(remoteIdentify.peerStore.protoBook.set.callCount).to.equal(1)

      const addresses = localIdentify.peerStore.addressBook.get(localPeer)
      expect(addresses).to.exist()
      expect(addresses).have.lengthOf(listenMaddrs.length)
      expect(addresses.map((a) => a.multiaddr)).to.eql(listenMaddrs)

      const [peerId2, protocols] = remoteIdentify.peerStore.protoBook.set.firstCall.args
      expect(peerId2.bytes).to.eql(localPeer.bytes)
      expect(protocols).to.eql(Array.from(localProtocols))
    })
  })

  describe('libp2p.dialer.identifyService', () => {
    let peerId
    let libp2p
    let remoteLibp2p

    before(async () => {
      peerId = await PeerId.createFromJSON(Peers[0])
    })

    afterEach(async () => {
      sinon.restore()
      libp2p && await libp2p.stop()
      libp2p = null
    })

    after(async () => {
      remoteLibp2p && await remoteLibp2p.stop()
    })

    it('should run identify automatically after connecting', async () => {
      libp2p = new Libp2p({
        ...baseOptions,
        peerId
      })

      await libp2p.start()

      sinon.spy(libp2p.identifyService, 'identify')
      const peerStoreSpyConsumeRecord = sinon.spy(libp2p.peerStore.addressBook, 'consumePeerRecord')
      const peerStoreSpyAdd = sinon.spy(libp2p.peerStore.addressBook, 'add')

      const connection = await libp2p.dialer.connectToPeer(remoteAddr)
      expect(connection).to.exist()

      // Wait for peer store to be updated
      // Dialer._createDialTarget (add), Identify (consume), Create self (consume)
      await pWaitFor(() => peerStoreSpyConsumeRecord.callCount === 2 && peerStoreSpyAdd.callCount === 1)
      expect(libp2p.identifyService.identify.callCount).to.equal(1)

      // The connection should have no open streams
      expect(connection.streams).to.have.length(0)
      await connection.close()
    })

    it('should push protocol updates to an already connected peer', async () => {
      libp2p = new Libp2p({
        ...baseOptions,
        peerId
      })

      await libp2p.start()

      sinon.spy(libp2p.identifyService, 'identify')
      sinon.spy(libp2p.identifyService, 'push')

      const connection = await libp2p.dialer.connectToPeer(remoteAddr)
      expect(connection).to.exist()
      // Wait for nextTick to trigger the identify call
      await delay(1)

      // Wait for identify to finish
      await libp2p.identifyService.identify.firstCall.returnValue
      sinon.stub(libp2p, 'isStarted').returns(true)

      libp2p.handle('/echo/2.0.0', () => {})
      libp2p.unhandle('/echo/2.0.0')

      // Verify the remote peer is notified of both changes
      expect(libp2p.identifyService.push.callCount).to.equal(2)
      for (const call of libp2p.identifyService.push.getCalls()) {
        const [connections] = call.args
        expect(connections.length).to.equal(1)
        expect(connections[0].remotePeer.toB58String()).to.equal(remoteAddr.getPeerId())
        const results = await call.returnValue
        expect(results.length).to.equal(1)
      }

      // Verify the streams close
      await pWaitFor(() => connection.streams.length === 0)
    })
  })
})
