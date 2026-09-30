import { authClient } from '../core/auth-client.js';
import {
  localSaveLibrary, ROOM_SAVE_KIND, createSavePackage, validateSavePackage, cleanSaveData
} from '../core/save-library.js';
import { projectedNarrativeDeliveries } from './ui-projection.js';

const ROOM_SCHEMA = 'naruto.local-room/v1';
const ID = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const roomFields = ['room_id', 'room_code', 'origin_type', 'lifecycle', 'viewer_seat', 'active_epoch_id', 'state_revision'];

function roomDescriptor(room) {
  return Object.fromEntries(roomFields.filter(key => room[key] !== undefined).map(key => [key, room[key]]));
}

export class LocalRoomHistory {
  constructor({ library = localSaveLibrary, userId = () => authClient.getUser()?.id, origin = () => globalThis.location?.origin } = {}) {
    this.library = library;
    this.userId = userId;
    this.origin = origin;
  }

  get owner() { return this.userId() ? `user:${this.userId()}` : null; }

  list() { return this.owner ? this.library.list(ROOM_SAVE_KIND, this.owner) : Promise.resolve([]); }

  async remember(state, { snapshot = false } = {}) {
    const room = state?.room;
    const owner = this.owner;
    if (!owner || !room?.room_id || !ID.test(room.room_id)) {
      throw new Error('请登录并连接房间后再保存');
    }
    const turn = state.latestCommittedTurn?.epoch_id === room.active_epoch_id
      ? state.latestCommittedTurn : (state.turn?.status === 'COMMITTED' ? state.turn : null);
    const publication = turn?.commit ? cleanSaveData({
      turn_id: turn.turn_id, turn_no: turn.turn_no, epoch_id: turn.epoch_id,
      narratives: projectedNarrativeDeliveries(turn),
      daily: turn.commit.shinobi_daily ?? null,
      // This is the authenticated member projection, never canonical state.
      state: turn.commit.state ?? null,
      checkpoint: turn.commit.checkpoint ?? null
    }) : null;
    const payload = {
      schema: ROOM_SCHEMA, owner, server_origin: this.origin(),
      room: roomDescriptor(room), publication
    };
    const id = `room:${owner}:${this.origin()}:${room.room_id}`;
    const previous = (await this.list()).find(entry => entry.id === id);
    const label = previous?.label || `房间 ${room.room_code || room.room_id}`;
    const pack = snapshot ? await createSavePackage(ROOM_SAVE_KIND, payload, label) : null;
    return this.library.put({
      id, kind: ROOM_SAVE_KIND, owner, label,
      roomId: room.room_id, roomCode: room.room_code || room.room_id,
      seat: room.viewer_seat, origin: this.origin(), lifecycle: room.lifecycle,
      turn: turn?.turn_no ?? state.turnContext?.turnNo ?? 0,
      epochId: room.active_epoch_id,
      ...(snapshot ? { savedTurn: publication?.turn_no ?? 0 } : {})
    }, pack);
  }

  async importPackage(pack) {
    await validateSavePackage(pack);
    if (pack.kind !== ROOM_SAVE_KIND || pack.payload?.schema !== ROOM_SCHEMA) throw new Error('请选择联机房间存档');
    const data = pack.payload;
    if (!this.owner || data.owner !== this.owner) throw new Error('这份房间档属于其他账号，请登录原账号后导入');
    if (!ID.test(data.room?.room_id ?? '') || !['A', 'B'].includes(data.room?.viewer_seat)
      || !/^https?:\/\//.test(data.server_origin ?? '')) throw new Error('房间存档信息不完整');
    if (new URL(data.server_origin).origin !== data.server_origin) throw new Error('房间存档的来源站点无效');
    const publication = data.publication;
    if (publication != null && (typeof publication !== 'object' || Array.isArray(publication)
      || !ID.test(publication.turn_id ?? '') || !ID.test(publication.epoch_id ?? '')
      || !Number.isSafeInteger(publication.turn_no) || publication.turn_no < 1
      || !Array.isArray(publication.narratives)
      || publication.narratives.some(item => !item || typeof item.text !== 'string' || typeof item.audience !== 'string')
      || (publication.state != null && (typeof publication.state !== 'object' || Array.isArray(publication.state))))) {
      throw new Error('房间快照的正文或变量结构无效');
    }
    // Imported snapshots get their own entry; importing an old file must not
    // overwrite a newer local snapshot of the same room.
    return this.library.put({
      id: `room-import:${crypto.randomUUID()}`, kind: ROOM_SAVE_KIND, owner: this.owner,
      label: String(pack.label || `房间 ${data.room.room_code || data.room.room_id}`).slice(0, 100),
      roomId: data.room.room_id, roomCode: data.room.room_code || data.room.room_id,
      seat: data.room.viewer_seat, origin: data.server_origin, lifecycle: data.room.lifecycle,
      epochId: data.room.active_epoch_id, turn: data.publication?.turn_no ?? 0,
      savedTurn: data.publication?.turn_no ?? 0
    }, pack);
  }

  async resume(id, connect) {
    const entry = await this.library.get(id, ROOM_SAVE_KIND, this.owner);
    if (entry.origin !== this.origin()) throw new Error('这份档来自其他站点，请在原站点导入后进入房间');
    try { return await connect(entry.roomId); }
    catch (error) {
      throw new Error(`暂时无法进入房间，本地记录仍保留。${error?.message || '请确认网络和原账号房间权限'}`);
    }
  }
}

export const localRoomHistory = new LocalRoomHistory();
