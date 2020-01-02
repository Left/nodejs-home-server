// package: 
// file: protocol.proto

import * as jspb from "google-protobuf";

export class Settings extends jspb.Message {
  hasName(): boolean;
  clearName(): void;
  getName(): string | undefined;
  setName(value: string): void;

  hasRusName(): boolean;
  clearRusName(): void;
  getRusName(): string | undefined;
  setRusName(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Settings.AsObject;
  static toObject(includeInstance: boolean, msg: Settings): Settings.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Settings, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Settings;
  static deserializeBinaryFromReader(message: Settings, reader: jspb.BinaryReader): Settings;
}

export namespace Settings {
  export type AsObject = {
    name?: string,
    rusName?: string,
  }
}

export class Hello extends jspb.Message {
  hasVersionmajor(): boolean;
  clearVersionmajor(): void;
  getVersionmajor(): number | undefined;
  setVersionmajor(value: number): void;

  hasVersionminor(): boolean;
  clearVersionminor(): void;
  getVersionminor(): number | undefined;
  setVersionminor(value: number): void;

  hasVersionlast(): boolean;
  clearVersionlast(): void;
  getVersionlast(): number | undefined;
  setVersionlast(value: number): void;

  hasSettings(): boolean;
  clearSettings(): void;
  getSettings(): Settings;
  setSettings(value?: Settings): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Hello.AsObject;
  static toObject(includeInstance: boolean, msg: Hello): Hello.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Hello, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Hello;
  static deserializeBinaryFromReader(message: Hello, reader: jspb.BinaryReader): Hello;
}

export namespace Hello {
  export type AsObject = {
    versionmajor?: number,
    versionminor?: number,
    versionlast?: number,
    settings: Settings.AsObject,
  }
}

export class Msg extends jspb.Message {
  hasId(): boolean;
  clearId(): void;
  getId(): number | undefined;
  setId(value: number): void;

  hasTimeseq(): boolean;
  clearTimeseq(): void;
  getTimeseq(): number | undefined;
  setTimeseq(value: number): void;

  hasHello(): boolean;
  clearHello(): void;
  getHello(): Hello | undefined;
  setHello(value?: Hello): void;

  clearIrkeyperiodsList(): void;
  getIrkeyperiodsList(): Array<number>;
  setIrkeyperiodsList(value: Array<number>): void;
  addIrkeyperiods(value: number, index?: number): number;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Msg.AsObject;
  static toObject(includeInstance: boolean, msg: Msg): Msg.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Msg, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Msg;
  static deserializeBinaryFromReader(message: Msg, reader: jspb.BinaryReader): Msg;
}

export namespace Msg {
  export type AsObject = {
    id?: number,
    timeseq?: number,
    hello?: Hello.AsObject,
    irkeyperiodsList: Array<number>,
  }
}

