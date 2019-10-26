
export interface Changeable<T> {
    whenChanged(): Promise<void>;
    get(): T;
    id(): string;
}

export interface AProp<T, S=T> extends Changeable<T> {
    set(v: S): void;
}

export abstract class HTML implements Changeable<string> {
    public abstract whenChanged(): Promise<void>;
    public abstract get(): string;
    public abstract id(): string;
}

export type ToStringFunc<T> = (v:T) => string;

export class Span<T> extends HTML {
    constructor(private prop: Changeable<T>, private toStr: ToStringFunc<T> = (v:T) => v.toString()) {
        super();
    }

    public get(): string {
        return `<span id='${this.id()}'>${this.toStr(this.prop.get())}</span>`;
    }

    public whenChanged(): Promise<void> {
        return this.prop.whenChanged();
    }

    public id(): string {
        return "span." + this.prop.id();
    }
}

