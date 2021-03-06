import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import { clearInterval } from "timers";


export function padLeft(s: string, padString: string, targetLength: number) {
    targetLength = targetLength >> 0; //floor if number or convert non-number to 0;
    padString = String(padString || ' ');
    if (s.length > targetLength) {
        return String(s);
    }
    else {
        targetLength = targetLength - s.length;
        if (targetLength > padString.length) {
            padString += padString.repeat(targetLength/padString.length); //append to original to ensure we are longer than needed
        }
        return padString.slice(0,targetLength) + String(s);
    }
};

export function splitLines(s: string): string[] {
    return s.split(/\r\n|\r|\n/);
}

export function runShell(cmd: string, args: string[]): Promise<string> {
    // console.log("runShell", args.join(' '));
    return new Promise<string>((accept, reject) => {
        const out: string[] = [];
        const pr = child_process.spawn(cmd, args);
        pr.on('error', (err: Error) => {
            reject(err);
        });
        pr.on('close', () => {
            accept(out.join(''));
        });
        pr.stdout.on("data", (d) => {
            out.push(d.toString());
        });
    });
}

export function wrapToHTML(tag: string| [string, {[k: string]: string}], body?: string ): string {
    if (typeof tag == "string") {
        return `<${tag}>\n${body}\n</${tag}>`;
    } else {
        const props = Object.getOwnPropertyNames(tag[1]).map(pn => pn + "=\"" + tag[1][pn] + "\"");
        return `<${tag[0]} ${props.join(" ")}` + (!!body ? `>\n${body}\n</${tag[0]}>` : ">");
    }
} 

function toDoubleZero(x: number): string {
    if (x > 9) {
        return '' + x;
    } else {
        return '0' + x;
    }
}

function toTripleZero(x: number): string {
    if (x <= 9) {
        return '00' + x;
    } else if (x <= 99) {
        return '0' + x;
    } else {
        return '' + x;
    }
}

export function toHMS(d: Date): string {
    return toDoubleZero(d.getHours()) + ":" + toDoubleZero(d.getMinutes()) + " " + toDoubleZero(Math.floor(d.getSeconds())) + "." +
        toTripleZero(d.getMilliseconds());
}

export function toHourMinSec(seconds: number): string {
    var data: { n: number, str: string[] }[] = [
        { n: 3600, str: ["часов", "час", "часа", "часа", "часа", "часов", "часов", "часов", "часов", "часов"]}, 
        { n: 60, str: ["минут", "минуту", "минуты", "минуты", "минуты", "минут", "минут", "минут", "минут", "минут" ]}, 
        { n: 1, str: ["секунд", "секунду", "секунды", "секунды", "секунды", "секунд", "секунд", "секунд", "секунд", "секунд"]}
    ];
    var res: string[] = [];
    data.forEach(d => {
        if (seconds >= d.n) {
            const v = Math.floor(seconds / d.n);
            res.push(v + " " + d.str[v % 10]);
            seconds = seconds % d.n;
        }
    });
    return res.join(' ');
}

export interface Disposable {
    dispose(): void;
}

export const emptyDisposable: Disposable = {
    dispose() {}
}

export function doAt(hour: number, min: number, sec: number, runnable: () => void): Disposable {
    let cancelled = false;
    let interval1: NodeJS.Timer;
    const timer1 = setTimeout(() => {
        if (!cancelled) {
            runnable();
            interval1 = setInterval(() => {
                if (!cancelled) {
                    runnable();
                }
            }, 24*60*60*1000);
        }
    }, (nextTimeAt(hour, min, sec).getTime()) - (new Date().getTime()));

    return {
        dispose: () => {
            cancelled = true;
            if (timer1)
                clearTimeout(timer1);
            if (interval1)
                clearInterval(interval1);
        }
    };
}

export function nextTimeAt(hour: number, min: number, sec: number): Date {
    const now = new Date();
    const then = new Date();
    then.setHours(hour);
    then.setMinutes(min);
    then.setSeconds(sec);
    if (then.getTime() < now.getTime()) {
        then.setDate(then.getDate() + 1);
    }
    return then;
}

type CancellablePromise<T> = Promise<T> & { cancel: () => void };

export function delay(time: number): CancellablePromise<void> {
    let to: number | undefined;
    const ret = new Promise<void>(function(resolve) { 
        to = setTimeout(resolve, time);
    }) as CancellablePromise<void>;
    ret.cancel = () => {
        if (to) {
            clearTimeout(to);
        }
    };

    return ret;
}


export function doWithTimeout<T>(action: () => Promise<T>, defVal: () => T, timeoutMs: number): Promise<T> {
    const timeout = delay(timeoutMs);
    return Promise.race([
        action().then(x => { 
            timeout.cancel(); 
            return x; 
        }),
        timeout.then(() => {
            return defVal();
        })
    ])
}

export function trace<T>(x: T): T {
    console.log(x);
    return x;
}

export function parseOr(str: string, regex:RegExp, fallback: string): string {
    try {
        const matched = str.match(regex);
        if (matched) {
            return matched[1];
        }
    } catch (e) {
        return fallback;        
    }
    return fallback;
}

export function numArrToVal(arr: string[], limitSize: number = 3): number {
    return arr.slice(Math.max(arr.length - limitSize, 0)).reduce((x: number, curr: string) => {
        return x * 10 + +(curr.substr(1));
    }, 0)
}

export function arraysAreEqual<T>(a1: T[], a2: T[]) {
    return a1.length == a2.length && a1.every((el, ind) => el === a2[ind]);
}

export function isNumKey(n: string): boolean {
    return n.length === 2 && n[0] === 'n'
}

export function getFirstNonPrefixIndex(arr: string[], prefix: string) {
    var firstNonPref = arr.findIndex(x => x !== prefix);
    if (firstNonPref === -1) {
        firstNonPref = arr.length;
    }
    return firstNonPref;
}

export function kbmbgb(bytes: number): string {
    const a = ["байт", "кб", "мб", "гб", "тб"];
    let j = 1;
    for (let i = 0; i < a.length; ++i, j *= 1024) {
        let s = (bytes/j).toLocaleString('ru', {minimumIntegerDigits: 1, maximumFractionDigits: 1, useGrouping: false}) + " " + a[i];
        if (bytes < j*1024 || i === (a.length-1)) {
            return s;
        }
    }
    return "";
}

export function isKeyAndNum(prefix: string[], arr: string[]): boolean {
    return arraysAreEqual(arr.slice(0, prefix.length), prefix) && 
        arr.slice(prefix.length).every(n => isNumKey(n));
}

export function thisOrNextDayFromHMS(hh: number, mm: number, ss: number): Date {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, ss !== null ? ss : 0)
    if (d.getTime() < new Date().getTime()) {
        // Add a day to point to tomorrow
        d.setDate(d.getDate() + 1);
    }
    return d;
}

export function tempAsString(temp: number) {
    return (temp == 0 ? "" : (temp > 0 ? "+" : "")) + temp.toLocaleString('ru', {minimumIntegerDigits: 1, maximumFractionDigits: 1, useGrouping: false}) + "\xB0";
}

export interface Config<T> {
    readonly def: T;
    read(): Promise<T>;
    change(mod: (t: T) => void): Promise<void>;
    change(props: Partial<T>): Promise<void>;
    last(): T
}

export function toFixedPoint(v: number, fracDigits: number = 2): string {
    return v.toLocaleString('ru', {
        minimumIntegerDigits: 1, 
        maximumFractionDigits: fracDigits, 
        minimumFractionDigits: fracDigits,
        useGrouping: false
    });
}

export function newConfig<T extends Object>(initial: T, fileName: string): Config<T> {
    return new (class C implements Config<T> {
        private _read: boolean = false;
        private _data?: T;
        public def = initial;

        private fullConfFilePath(): string {
            return os.homedir() + `/${fileName}.conf.json`;
        }

        last(): T {
            return this._data || initial;
        }

        read(): Promise<T> {
            return new Promise<T>((accept, reject) => {
                if (this._read) {
                    // Nothing to do, data was already read
                    accept(this._data);
                    return;
                }

                const fname = this.fullConfFilePath();
                fs.exists(fname, (exists) => {
                    if (exists) {
                        fs.readFile(fname, (err, data) => {
                            if (err) {      
                                this._data = initial;
                                this._read = true;
                                accept(this._data);
                            } else {
                                try {
                                    const parsed = JSON.parse(data.toString()) as T;
                                    this._data = parsed;
                                    this._read = true;
                                    for (const pn of Object.getOwnPropertyNames(initial)) {
                                        const kn = pn as (keyof T);
                                        if (!(pn in this._data) || this._data[kn] === null) {
                                            this._data[kn] = initial[kn];
                                        }
                                    } 
                                    
                                    accept(this._data);
                                } catch (e) {
                                    console.log('Bad file ', this.fullConfFilePath(), data.toString(), e); 
                                    this._data = initial;
                                    this._read = true;
                                    accept(this._data);
                                    this.writeFileAsync();
                                }
                            }
                        });
                    } else {
                        this._data = initial;
                        this._read = true;
                        accept(this._data);
                    }
                })
            }); 
        }

        public change(props: ((t: T) => void)): Promise<void>;
        public change(props: Partial<T>): Promise<void>;
        async change(props: any): Promise<void> {
            let t = await this.read();
            if (typeof props == 'function') {
                props(t);
            } else {
                this._data = { ...this._data, ...props};
            }
            return this.writeFileAsync();
        }

        writeFileAsync() : Promise<void> {
            return new Promise<void>((accept, reject) => fs.unlink(this.fullConfFilePath(), (err) => {
                fs.writeFile(this.fullConfFilePath(), JSON.stringify(this._data), (err) => {
                    if (err) {
                        console.log('Bad file ', this.fullConfFilePath(), this._data);
                        reject(err);
                    } else {
                        accept(void 0);
                    }
                })
            }));
        }


    })();
}

/**
 * Allows to filter all props of expected type
 */
export type FilterFlags<Base, Condition> = {
    [Key in keyof Base]: 
        Base[Key] extends Condition ? Key : never
};

/////////////////////////////////////////////////////////////////
// Date and time

export type HourMin = {
    h: number;
    m: number;
    s?: number;
}

export function isHourMin(x: any): x is HourMin {
    return typeof(x) === 'object' && 'h' in x && 'm' in x;
}

export function nowHourMin(): HourMin {
    const d = new Date();
    return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
}

export function toSec(hm: HourMin): number {
    return hm.h*3600 + hm.m*60 + (hm.s || 0);
}

export function hourMinCompare(hm1: HourMin, hm2: HourMin): number {
    if (hm1.h == hm2.h) {
        if (hm1.m == hm2.m) {
            return (hm1.s || 0) - (hm2.s || 0);
        }
    
        return hm1.m - hm2.m;
    }
    
    return hm1.h - hm2.h;
}

/////////////////////////////////////////////////////////////////