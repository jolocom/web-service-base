const uuidv4 = require('uuid').v4
const QRCode = require("qrcode");

import { JolocomSDK, Agent, JolocomLib, JSONWebToken, ChannelTransportType } from '@jolocom/sdk'
import { Channel } from '@jolocom/sdk/js/channels'

export interface WebEndPoints {
  interxn: string
  chan: string
  rpc: string
}

export interface JolocomWebServiceOptions {
  publicHostport?: string
  tls?: boolean
  rpcMap?: RPCMap
  paths?: WebEndPoints
};

interface JWTDesc {
  id: string
  jwt: string
  qr: string
}

interface WebSocket { send: (d: any) => void }

type InteractionCallback = (payload: string) => Promise<JSONWebToken<any> | void>

interface RPCHandlerCtx {
  createChannel: ({ description: string }) => Promise<Channel>
  createInteractionCallbackURL: (cb: InteractionCallback) => string
  wrapJWT: (jwt: string | JSONWebToken<any>) => Promise<JWTDesc>
  updateFrontend: (upd: Record<string, any>) => Promise<void>
}

interface RPCMap {
  [key: string]: (request: any, ctx: RPCHandlerCtx) => Promise<any>
}
interface RPCMessage { id: string, rpc: string, request: string }

const defaultRPCMap: RPCMap = {
  // TODO
}

export class JolocomWebServiceBase {
  agent: Agent
  rpcMap: RPCMap

  protected publicHostport?: string
  protected publicWsUrl!: string
  protected publicHttpUrl!: string
  protected enableTls: boolean
  protected paths: WebEndPoints

  constructor(agent: Agent, options: JolocomWebServiceOptions = {}){
    this.agent = agent
    this.rpcMap = options.rpcMap || defaultRPCMap
    this.enableTls = !!options.tls
    this.publicHostport = options.publicHostport || 'localhost:9000'
    this.paths = {
      interxn: '/interxn',
      chan: '/chan',
      rpc: '/rpc',
      ...options.paths
    }
  }

  protected _callbacks: {
    [id: string]: InteractionCallback
  } = {}

  createInteractionCallbackURL(cb: InteractionCallback) {
    const id = uuidv4()
    this._callbacks[id] = cb
    return `${this.publicHttpUrl}${this.paths.interxn}/${id}`
  }

  async processCallback(cbId: string, payload: { token: string }) {
    console.log('received callback!!', cbId, payload)

    const cb = this._callbacks[cbId]
    if (!cb) throw new Error('no callback for ' + cbId)
    const tokenOrJsonResp = await cb(payload.token)
    if (tokenOrJsonResp instanceof JSONWebToken) {
      return { token: tokenOrJsonResp.encode() } // NOTE: legacy, smartwallet 1.9 expects this
    } else {
      // TODO return nothing
      return ''
    }
  }

  async updateFrontend(msg: RPCMessage, ws: WebSocket, upd: Record<string, any>)
  {
    ws.send(JSON.stringify({
      id: msg.id,
      response: upd
    }))
  }

  private _basePath = ''

  set basePath(p: string) {
    this._basePath = p
    const tls = this.enableTls ? 's' : ''
    this.publicWsUrl = `ws${tls}://${this.publicHostport || 'localhost'}${p}`
    this.publicHttpUrl = `http${tls}://${this.publicHostport || 'localhost'}${p}`
  }

  get basePath() {
    return this._basePath
  }

  async createChannel({ description }: { description: string }): Promise<Channel> {
    const wsUrl = `${this.publicWsUrl}${this.paths.chan}`
    const initTokenJwt = await this.agent.establishChannelRequestToken({
      description,
      transports: [
        {
          type: ChannelTransportType.WebSockets,
          config: wsUrl
        }
      ]
    })
    const initInterxn = await this.agent.findInteraction(initTokenJwt)
    if (!initInterxn) throw new Error("interaction (that was just created) cannot be found???")
    return this.agent.channels.create(initInterxn)
  }

  async processRPC(msg: RPCMessage, ws?: WebSocket) {
    const handler = this.rpcMap[msg.rpc]
    if (!handler) throw new Error('unknown RPC Call "' + msg.rpc + '"')

    const ctx: RPCHandlerCtx = {
      wrapJWT: this.wrapJWT.bind(this),
      createChannel: this.createChannel.bind(this),
      createInteractionCallbackURL: this.createInteractionCallbackURL.bind(this),
      updateFrontend: this.updateFrontend.bind(this, msg, ws)
    }
    const response = await handler(msg.request, ctx)
    return {
      id: msg.id,
      request: msg,
      response
    }
  }

  async wrapJWT(tokenOrJwt: string | JSONWebToken<any>): Promise<JWTDesc> {
    let jwt: string, token: JSONWebToken<any>
    if (typeof tokenOrJwt === 'string') {
      jwt = tokenOrJwt
      token = JolocomLib.parse.interactionToken.fromJWT(jwt)
    } else {
      token = tokenOrJwt
      jwt = token.encode()
    }
    const qr = await QRCode.toDataURL(jwt)
    return {
      id: token.nonce,
      jwt,
      qr,
    }
  }
}
