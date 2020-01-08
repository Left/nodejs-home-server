// package: 
// file: protocol.proto

import * as jspb from "google-protobuf";

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

  hasScreenenabled(): boolean;
  clearScreenenabled(): void;
  getScreenenabled(): boolean | undefined;
  setScreenenabled(value: boolean): void;

  hasSettings(): boolean;
  clearSettings(): void;
  getSettings(): string | undefined;
  setSettings(value: string): void;

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
    screenenabled?: boolean,
    settings?: string,
  }
}

export class Relay extends jspb.Message {
  hasId(): boolean;
  clearId(): void;
  getId(): number | undefined;
  setId(value: number): void;

  hasState(): boolean;
  clearState(): void;
  getState(): boolean | undefined;
  setState(value: boolean): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Relay.AsObject;
  static toObject(includeInstance: boolean, msg: Relay): Relay.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Relay, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Relay;
  static deserializeBinaryFromReader(message: Relay, reader: jspb.BinaryReader): Relay;
}

export namespace Relay {
  export type AsObject = {
    id?: number,
    state?: boolean,
  }
}

export class ParsedRemote extends jspb.Message {
  hasRemote(): boolean;
  clearRemote(): void;
  getRemote(): string | undefined;
  setRemote(value: string): void;

  hasKey(): boolean;
  clearKey(): void;
  getKey(): string | undefined;
  setKey(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ParsedRemote.AsObject;
  static toObject(includeInstance: boolean, msg: ParsedRemote): ParsedRemote.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ParsedRemote, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ParsedRemote;
  static deserializeBinaryFromReader(message: ParsedRemote, reader: jspb.BinaryReader): ParsedRemote;
}

export namespace ParsedRemote {
  export type AsObject = {
    remote?: string,
    key?: string,
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

  hasDebuglogmessage(): boolean;
  clearDebuglogmessage(): void;
  getDebuglogmessage(): string | undefined;
  setDebuglogmessage(value: string): void;

  clearRelaystatesList(): void;
  getRelaystatesList(): Array<Relay>;
  setRelaystatesList(value: Array<Relay>): void;
  addRelaystates(value?: Relay, index?: number): Relay;

  hasParsedremote(): boolean;
  clearParsedremote(): void;
  getParsedremote(): ParsedRemote | undefined;
  setParsedremote(value?: ParsedRemote): void;

  hasButtonpressed(): boolean;
  clearButtonpressed(): void;
  getButtonpressed(): boolean | undefined;
  setButtonpressed(value: boolean): void;

  hasWeight(): boolean;
  clearWeight(): void;
  getWeight(): number | undefined;
  setWeight(value: number): void;

  hasTemp(): boolean;
  clearTemp(): void;
  getTemp(): number | undefined;
  setTemp(value: number): void;

  hasHumidity(): boolean;
  clearHumidity(): void;
  getHumidity(): number | undefined;
  setHumidity(value: number): void;

  hasPressure(): boolean;
  clearPressure(): void;
  getPressure(): number | undefined;
  setPressure(value: number): void;

  hasPotentiometer(): boolean;
  clearPotentiometer(): void;
  getPotentiometer(): number | undefined;
  setPotentiometer(value: number): void;

  hasAtxstate(): boolean;
  clearAtxstate(): void;
  getAtxstate(): boolean | undefined;
  setAtxstate(value: boolean): void;

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
    debuglogmessage?: string,
    relaystatesList: Array<Relay.AsObject>,
    parsedremote?: ParsedRemote.AsObject,
    buttonpressed?: boolean,
    weight?: number,
    temp?: number,
    humidity?: number,
    pressure?: number,
    potentiometer?: number,
    atxstate?: boolean,
  }
}

export class ScreenOffset extends jspb.Message {
  hasX(): boolean;
  clearX(): void;
  getX(): number | undefined;
  setX(value: number): void;

  hasY(): boolean;
  clearY(): void;
  getY(): number | undefined;
  setY(value: number): void;

  hasAtms(): boolean;
  clearAtms(): void;
  getAtms(): number | undefined;
  setAtms(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ScreenOffset.AsObject;
  static toObject(includeInstance: boolean, msg: ScreenOffset): ScreenOffset.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ScreenOffset, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ScreenOffset;
  static deserializeBinaryFromReader(message: ScreenOffset, reader: jspb.BinaryReader): ScreenOffset;
}

export namespace ScreenOffset {
  export type AsObject = {
    x?: number,
    y?: number,
    atms?: number,
  }
}

export class ScreenContent extends jspb.Message {
  hasWidth(): boolean;
  clearWidth(): void;
  getWidth(): number | undefined;
  setWidth(value: number): void;

  hasHeight(): boolean;
  clearHeight(): void;
  getHeight(): number | undefined;
  setHeight(value: number): void;

  hasContent(): boolean;
  clearContent(): void;
  getContent(): Uint8Array | string;
  getContent_asU8(): Uint8Array;
  getContent_asB64(): string;
  setContent(value: Uint8Array | string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ScreenContent.AsObject;
  static toObject(includeInstance: boolean, msg: ScreenContent): ScreenContent.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ScreenContent, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ScreenContent;
  static deserializeBinaryFromReader(message: ScreenContent, reader: jspb.BinaryReader): ScreenContent;
}

export namespace ScreenContent {
  export type AsObject = {
    width?: number,
    height?: number,
    content: Uint8Array | string,
  }
}

export class MsgBack extends jspb.Message {
  hasId(): boolean;
  clearId(): void;
  getId(): number | undefined;
  setId(value: number): void;

  hasIntroduceyourself(): boolean;
  clearIntroduceyourself(): void;
  getIntroduceyourself(): boolean | undefined;
  setIntroduceyourself(value: boolean): void;

  hasReboot(): boolean;
  clearReboot(): void;
  getReboot(): boolean | undefined;
  setReboot(value: boolean): void;

  hasScreenenable(): boolean;
  clearScreenenable(): void;
  getScreenenable(): boolean | undefined;
  setScreenenable(value: boolean): void;

  hasTestmsg(): boolean;
  clearTestmsg(): void;
  getTestmsg(): string | undefined;
  setTestmsg(value: string): void;

  hasUnixtime(): boolean;
  clearUnixtime(): void;
  getUnixtime(): number | undefined;
  setUnixtime(value: number): void;

  hasTexttoshow(): boolean;
  clearTexttoshow(): void;
  getTexttoshow(): string | undefined;
  setTexttoshow(value: string): void;

  hasTimemstoshow(): boolean;
  clearTimemstoshow(): void;
  getTimemstoshow(): number | undefined;
  setTimemstoshow(value: number): void;

  hasShowtype(): boolean;
  clearShowtype(): void;
  getShowtype(): MsgBack.ShowTypeMap[keyof MsgBack.ShowTypeMap] | undefined;
  setShowtype(value: MsgBack.ShowTypeMap[keyof MsgBack.ShowTypeMap]): void;

  hasRelaystoswitch(): boolean;
  clearRelaystoswitch(): void;
  getRelaystoswitch(): number | undefined;
  setRelaystoswitch(value: number): void;

  hasRelaystoswitchstate(): boolean;
  clearRelaystoswitchstate(): void;
  getRelaystoswitchstate(): boolean | undefined;
  setRelaystoswitchstate(value: boolean): void;

  hasAtxenable(): boolean;
  clearAtxenable(): void;
  getAtxenable(): boolean | undefined;
  setAtxenable(value: boolean): void;

  hasPlaymp3(): boolean;
  clearPlaymp3(): void;
  getPlaymp3(): number | undefined;
  setPlaymp3(value: number): void;

  hasVolume(): boolean;
  clearVolume(): void;
  getVolume(): number | undefined;
  setVolume(value: number): void;

  hasBrightness(): boolean;
  clearBrightness(): void;
  getBrightness(): number | undefined;
  setBrightness(value: number): void;

  hasPwmpin(): boolean;
  clearPwmpin(): void;
  getPwmpin(): number | undefined;
  setPwmpin(value: number): void;

  hasPwmvalue(): boolean;
  clearPwmvalue(): void;
  getPwmvalue(): number | undefined;
  setPwmvalue(value: number): void;

  hasPwmperiod(): boolean;
  clearPwmperiod(): void;
  getPwmperiod(): number | undefined;
  setPwmperiod(value: number): void;

  hasLedvalue(): boolean;
  clearLedvalue(): void;
  getLedvalue(): string | undefined;
  setLedvalue(value: string): void;

  hasLedperiod(): boolean;
  clearLedperiod(): void;
  getLedperiod(): number | undefined;
  setLedperiod(value: number): void;

  hasLedbasecolor(): boolean;
  clearLedbasecolor(): void;
  getLedbasecolor(): string | undefined;
  setLedbasecolor(value: string): void;

  hasLedblinkcolors(): boolean;
  clearLedblinkcolors(): void;
  getLedblinkcolors(): string | undefined;
  setLedblinkcolors(value: string): void;

  hasScreencontent(): boolean;
  clearScreencontent(): void;
  getScreencontent(): ScreenContent | undefined;
  setScreencontent(value?: ScreenContent): void;

  hasScreenoffsetfrom(): boolean;
  clearScreenoffsetfrom(): void;
  getScreenoffsetfrom(): ScreenOffset | undefined;
  setScreenoffsetfrom(value?: ScreenOffset): void;

  hasScreenoffsetto(): boolean;
  clearScreenoffsetto(): void;
  getScreenoffsetto(): ScreenOffset | undefined;
  setScreenoffsetto(value?: ScreenOffset): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): MsgBack.AsObject;
  static toObject(includeInstance: boolean, msg: MsgBack): MsgBack.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MsgBack, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MsgBack;
  static deserializeBinaryFromReader(message: MsgBack, reader: jspb.BinaryReader): MsgBack;
}

export namespace MsgBack {
  export type AsObject = {
    id?: number,
    introduceyourself?: boolean,
    reboot?: boolean,
    screenenable?: boolean,
    testmsg?: string,
    unixtime?: number,
    texttoshow?: string,
    timemstoshow?: number,
    showtype?: MsgBack.ShowTypeMap[keyof MsgBack.ShowTypeMap],
    relaystoswitch?: number,
    relaystoswitchstate?: boolean,
    atxenable?: boolean,
    playmp3?: number,
    volume?: number,
    brightness?: number,
    pwmpin?: number,
    pwmvalue?: number,
    pwmperiod?: number,
    ledvalue?: string,
    ledperiod?: number,
    ledbasecolor?: string,
    ledblinkcolors?: string,
    screencontent?: ScreenContent.AsObject,
    screenoffsetfrom?: ScreenOffset.AsObject,
    screenoffsetto?: ScreenOffset.AsObject,
  }

  export interface ShowTypeMap {
    SHOW: 0;
    TUNE: 1;
    ADDITIONAL: 2;
  }

  export const ShowType: ShowTypeMap;
}

