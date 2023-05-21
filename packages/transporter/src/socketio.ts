/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { eventWithTime } from '@rrweb/types';
import { Chunk, RemoteControlPayload } from '@syncit/core';
import { io, Socket } from "socket.io-client";
import {
  Transporter,
  TransporterEvents,
  TransporterEventHandler,
  TransporterHandlers,
} from '@syncit/core';


export class SocketioTransporter implements Transporter {
  handlers: TransporterHandlers = {
    [TransporterEvents.SourceReady]: [],
    [TransporterEvents.MirrorReady]: [],
    [TransporterEvents.Start]: [],
    [TransporterEvents.SendRecord]: [],
    [TransporterEvents.AckRecord]: [],
    [TransporterEvents.Stop]: [],
    [TransporterEvents.RemoteControl]: [],
  };

  socket: Socket;

  constructor(options: { url: string }) {
    const { url } = options;
    this.socket = io(url, {
      transports: ['websocket'],
      reconnection: false
    });
    this.socket.on("message", (data: string) => {
      console.log(data);
      const message = JSON.parse(data);
      this.handlers[message.event as TransporterEvents].map(h =>
        h({
          event: message.event,
          payload: message.payload,
        })
      );
    });
  }

  login() {
    return Promise.resolve(true);
  }

  setItem(params: { event: TransporterEvents; payload?: unknown }) {
    if (!this.socket.connected) {
      return setTimeout(() => {
        this.setItem(params);
      }, 50);
    }
    this.socket.send(JSON.stringify(params));
    // jest could not listen to storage event in JSDOM, not a big deal at here.
    if (process.env.NODE_ENV === 'test') {
      this.handlers[params.event].map(h => h(params));
    }
  }

  sendSourceReady() {
    this.setItem({
      event: TransporterEvents.SourceReady,
    });
    return Promise.resolve();
  }

  sendMirrorReady() {
    this.setItem({
      event: TransporterEvents.MirrorReady,
    });
    return Promise.resolve();
  }

  sendStart() {
    this.setItem({
      event: TransporterEvents.Start,
    });
    return Promise.resolve();
  }

  sendRecord(record: Chunk<eventWithTime>) {
    this.setItem({
      event: TransporterEvents.SendRecord,
      payload: record,
    });
    return Promise.resolve();
  }

  ackRecord(id: number) {
    this.setItem({
      event: TransporterEvents.AckRecord,
      payload: id,
    });
    return Promise.resolve();
  }

  sendStop() {
    this.setItem({
      event: TransporterEvents.Stop,
    });
    return Promise.resolve();
  }

  sendRemoteControl(payload: RemoteControlPayload) {
    this.setItem({
      event: TransporterEvents.RemoteControl,
      payload,
    });
    return Promise.resolve();
  }

  on(event: TransporterEvents, handler: TransporterEventHandler) {
    this.handlers[event].push(handler);
  }
}
