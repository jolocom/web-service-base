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

interface RPCHandlerCtx {
  createChannel: ({ description: string }) => Promise<Channel>
  createInteractionCallbackURL: (cb: (payload: string, websocket: WebSocket | undefined) => Promise<JSONWebToken<any> | void>) => string
  wrapJWT: (jwt: string | JSONWebToken<any>) => Promise<JWTDesc>
}

interface RPCMap {
  [key: string]: (request: any, ctx: RPCHandlerCtx, websocket: WebSocket | undefined) => Promise<any>
}

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
    [id: string]: (payload: string, websocket) => Promise<JSONWebToken<any> | void>
  } = {}
  protected clientsWS: {
    [id: string]: WebSocket
  } = {}

  createInteractionCallbackURL(cb: (payload: string, websocket: WebSocket | undefined) => Promise<JSONWebToken<any> | void>) {
    const id = uuidv4()
    this._callbacks[id] = cb
    return `${this.publicHttpUrl}${this.paths.interxn}/${id}`
  }

  async processCallback(cbId: string, payload: { token: string }) {
    console.log('received callback!!', cbId, payload)

    const cb = this._callbacks[cbId]
    if (!cb) throw new Error('no callback for ' + cbId)
    const interxn = await this.agent.processJWT(payload.token);

    // Pass the websocket to the call back to enable it to send addional custom data
    const tokenResp = await cb(payload.token, this.clientsWS[interxn.id])

    try {      
      if (this.clientsWS[interxn.id]) {
        try {
            console.log("Client's WebSocket has been added to the list for the interxn.id", interxn.id);
            const message = JSON.stringify({
              id: interxn.id,
              status: "success",
              response: tokenResp,
            });
            this.clientsWS[interxn.id].send(message);
        } catch (error) {
            this.clientsWS[interxn.id].send(
              JSON.stringify({ id: interxn.id, status: "error", error })
            );
        }
      }
    } catch (error) {
      console.error("Someting when wrong while trying to send to the client over websocket", error);
    }

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

  async processRPC(msg: { id: string, rpc: string, request: string }, websocket: WebSocket | undefined) {
    const handler = this.rpcMap[msg.rpc]
    if (!handler) throw new Error('unknown RPC Call "' + msg.rpc + '"')

    const ctx: RPCHandlerCtx = {
      wrapJWT: this.wrapJWT.bind(this),
      createChannel: this.createChannel.bind(this),
      createInteractionCallbackURL: this.createInteractionCallbackURL.bind(this)
    }
    const response = await handler(msg.request, ctx, websocket)

    if (websocket) {
        const callbackID = response.id;
        this.clientsWS[callbackID] = websocket;
    }
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
