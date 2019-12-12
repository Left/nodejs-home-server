// package: 
// file: protocol.proto

import * as jspb from "google-protobuf";

export class SimpleMessage extends jspb.Message {
  hasId(): boolean;
  clearId(): void;
  getId(): number | undefined;
  setId(value: number): void;

  hasNum(): boolean;
  clearNum(): void;
  getNum(): number | undefined;
  setNum(value: number): void;

  hasStr(): boolean;
  clearStr(): void;
  getStr(): string | undefined;
  setStr(value: string): void;

  hasNum2(): boolean;
  clearNum2(): void;
  getNum2(): number | undefined;
  setNum2(value: number): void;

  hasNum3Add(): boolean;
  clearNum3Add(): void;
  getNum3Add(): number | undefined;
  setNum3Add(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): SimpleMessage.AsObject;
  static toObject(includeInstance: boolean, msg: SimpleMessage): SimpleMessage.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: SimpleMessage, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): SimpleMessage;
  static deserializeBinaryFromReader(message: SimpleMessage, reader: jspb.BinaryReader): SimpleMessage;
}

export namespace SimpleMessage {
  export type AsObject = {
    id?: number,
    num?: number,
    str?: string,
    num2?: number,
    num3Add?: number,
  }
}

