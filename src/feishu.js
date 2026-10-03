import * as lark from '@larksuiteoapi/node-sdk';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export function splitText(text, maxBytes = 12000) {
  const chunks = [];
  let part = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) { chunks.push(part); part = ''; bytes = 0; }
    part += char; bytes += size;
  }
  if (part) chunks.push(part);
  return chunks;
}

export function normalizeEvent(event) {
  const msg = event.message;
  if (event.sender?.sender_type !== 'user' || msg?.chat_type !== 'p2p' || msg.message_type !== 'text') return null;
  let content;
  try { content = JSON.parse(msg.content); } catch { return null; }
  if (typeof content.text !== 'string' || !event.sender.sender_id?.open_id || !msg.message_id || !msg.chat_id) return null;
  return { id: msg.message_id, userId: event.sender.sender_id.open_id, chatId: msg.chat_id,
    text: content.text.trim(), createdAt: Number(msg.create_time), replyTo: msg.parent_id ?? msg.root_id ?? null };
}

export class Feishu {
  constructor(appId, appSecret, log = console.log) {
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) throw new Error('App ID 格式不正确，请从飞书“凭证与基础信息”复制。');
    // Avoid SDK request/response logs containing credentials or conversation text.
    const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const config = { appId, appSecret, domain: lark.Domain.Feishu, logger: quiet };
    this.client = new lark.Client(config);
    this.ws = new lark.WSClient({ ...config, handshakeTimeoutMs: 15000,
      wsConfig: { pingTimeout: 120 },
      onReady: () => log('飞书长连接已建立；可以回到开发者后台保存事件订阅。'),
      onReconnecting: () => log('飞书连接中断，正在重连。'),
      onReconnected: () => log('飞书连接已恢复。'),
      onError: () => log('飞书连接失败，请检查应用凭证、网络和发布状态。'),
    });
  }

  async connect(onEvent) {
    await this.ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({
      'im.message.receive_v1': event => {
        // The handler only validates and journals. Long-running work runs outside the SDK's 3s ack window.
        const message = normalizeEvent(event);
        if (message) onEvent(message);
        return {};
      },
    }) });
  }

  async text(chatId, text, deliveryKey) {
    const result = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }),
        uuid: createHash('sha256').update(deliveryKey).digest('hex').slice(0, 32) },
    });
    if (result.code !== 0 || !result.data?.message_id) throw new Error(`飞书发送失败（${result.code ?? 'unknown'}）。`);
    return result.data.message_id;
  }

  async image(chatId, path, deliveryKey) {
    const upload = await this.client.im.image.create({ data: { image_type: 'message', image: createReadStream(path) } });
    const imageKey = upload?.image_key ?? upload?.data?.image_key;
    if (!imageKey) throw new Error('二维码图片上传失败。');
    const result = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }),
        uuid: createHash('sha256').update(deliveryKey).digest('hex').slice(0, 32) },
    });
    if (result.code !== 0 || !result.data?.message_id) throw new Error('二维码发送失败。');
    return result.data.message_id;
  }

  close() { this.ws.close({ force: true }); }
}
