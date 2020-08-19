const uuidv4 = require('uuid').v4
const QRCode = require("qrcode");

import { JolocomSDK, JolocomLib, JSONWebToken } from '@jolocom/sdk'

import { ChannelTransportType, Channel } from '@jolocom/sdk/js/src/lib/channels'
import { Interaction } from '@jolocom/sdk/js/src/lib/interactionManager/interaction'
import { InteractionTransportType, FlowType } from '@jolocom/sdk/js/src/lib/interactionManager/types'

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

interface RPCHandlerCtx {
  createChannel: ({ description: string }) => Promise<Channel>
  createInteractionCallbackURL: (cb: (payload: string) => Promise<JSONWebToken<any> | void>) => string
  wrapJWT: (jwt: string | JSONWebToken<any>) => Promise<JWTDesc>
}

interface RPCMap {
  [key: string]: (request: any, ctx: RPCHandlerCtx) => Promise<any>
}

const defaultRPCMap: RPCMap = {
  // TODO
}

export class JolocomWebServiceBase {
  sdk: JolocomSDK
  rpcMap: RPCMap

  protected publicHostport?: string
  protected publicWsUrl!: string
  protected publicHttpUrl!: string
  protected enableTls: boolean
  protected paths: WebEndPoints

  constructor(sdk: JolocomSDK, options: JolocomWebServiceOptions = {}){
    this.sdk = sdk
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
    [id: string]: (payload: string) => Promise<JSONWebToken<any> | void>
  } = {}

  createInteractionCallbackURL(cb: (payload: string) => Promise<JSONWebToken<any> | void>) {
    const id = uuidv4()
    this._callbacks[id] = cb
    return `${this.publicHttpUrl}${this.paths.interxn}/${id}`
  }

  async processCallback(cbId: string, payload: { token: string }) {
    console.log('received callback!!', cbId, payload)

    const cb = this._callbacks[cbId]
    if (!cb) throw new Error('no callback for ' + cbId)
    const tokenResp = await cb(payload.token)
    if (tokenResp) {
      return { token: tokenResp.encode() } // NOTE: legacy, smartwallet 1.9 expects this
    } else {
      // TODO return nothing
      return ''
    }
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
    const initTokenJwt = await this.sdk.establishChannelRequestToken({
      description,
      transports: [
        {
          type: ChannelTransportType.WebSockets,
          config: wsUrl
        }
      ]
    })
    const initInterxn = this.sdk.findInteraction(initTokenJwt)
    if (!initInterxn) throw new Error("interaction (that was just created) cannot be found???")
    return this.sdk.channels.create(initInterxn)
  }

  async processRPC(msg: { id: string, rpc: string, request: string }) {
    const handler = this.rpcMap[msg.rpc]
    if (!handler) throw new Error('unknown RPC Call "' + msg.rpc + '"')

    const response = await handler(msg.request, this)
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
