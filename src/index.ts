const uuidv4 = require('uuid').v4
const QRCode = require("qrcode");

import { JolocomSDK, JolocomLib, JSONWebToken } from '@jolocom/sdk'

import { ChannelTransportType, Channel } from '@jolocom/sdk/js/src/lib/channels'
import { Interaction } from '@jolocom/sdk/js/src/lib/interactionManager/interaction'
import { InteractionTransportType, FlowType } from '@jolocom/sdk/js/src/lib/interactionManager/types'

interface WebEndPoints {
  interxn: string
  chan: string
  rpc: string
}

type WebServiceOptions = {
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

interface RPCMap {
  [key: string]: (request: any, ctx: JolocomWebServiceBase) => Promise<any>
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

  constructor(sdk: JolocomSDK, options: WebServiceOptions = {}){
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

  public addCallback(cb: (payload: string) => Promise<JSONWebToken<any> | void>) {
    const id = uuidv4()
    this._callbacks[id] = cb
    return `${this.publicHttpUrl}${this.paths.interxn}/${id}`
  }

  public async processCallback(cbId: string, payload: { token: string }) {
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

  createChannel(send: (msg: string) => void) {
    return new WebChannel(this, send)
  }

  public async createChannelRequest({ description }: { description: string }): Promise<JWTDesc> {
    const wsUrl = `${this.publicWsUrl}${this.paths.chan}`
    /* an improved API may look something like:
      const interxn = await this.sdk.establishChannel(
        {
          description,
          transports: [
            {
              type: ChannelTransportType.WebSockets,
              args: wsUrl
            }
          ]
        },
        {
          type: InteractionTransportType.HTTP,
          args: callbackURL
        }
      )
      const initToken = interxn.getMessages()[0]
    */
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
    const ch = await this.sdk.channels.create(initInterxn)
    const chReq = this.wrapJwt(initTokenJwt)
    return chReq
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

  public async wrapJwt(jwt: string): Promise<JWTDesc> {
    const token = JolocomLib.parse.interactionToken.fromJWT(jwt)
    const qr = await QRCode.toDataURL(jwt)
    return {
      id: token.nonce,
      jwt,
      qr,
    }
  }
}

class WebChannel {
  ctx: JolocomWebServiceBase
  sdkChan?: Channel
  id?: string
  send: (msg: string) => void

  constructor(ctx: JolocomWebServiceBase, send: (msg: string) => void) {
    this.ctx = ctx
    this.send = send
  }

  async onMessage(msg: string) {
    if (!msg) throw new Error('empty message!')

    if (!this.sdkChan) {
      this.sdkChan = await this.ctx.sdk.channels.findByJWT(msg)
      if (!this.sdkChan) throw new Error('unknown channel!')
      this.id = this.sdkChan.id
      // @ts-ignore
      this.sdkChan.transportAPI = {
        send: this.send
      }
    }

    this.sdkChan.processJWT(msg)
  }

}

