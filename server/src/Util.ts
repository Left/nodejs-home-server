import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";

export function splitLines(s: string): string[] {
    return s.split(/\r\n|\r|\n/);
}

export function runShell(cmd: string, args: string[]): Promise<String> {
    // console.log("runShell", args.join(' '));
    return new Promise<String>((accept, reject) => {
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

export function toHMS(d: Date): string {
    function toDoubleZero(x: number): string {
        if (x > 9) {
            return '' + x;
        } else {
            return '0' + x;
        }
    }
    return toDoubleZero(d.getHours()) + ":" + toDoubleZero(d.getMinutes()) + "." + toDoubleZero(Math.floor(d.getSeconds()));
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

export function delay(time: number): Promise<void> {
    return new Promise<void>(function(resolve) { 
        setTimeout(resolve, time);
    });
 }

export function trace<T>(x: T): T {
    console.log(x);
    return x;
}

export function parseOr(str: string, regex:RegExp, fallback: string): string {
    const matched = str.match(regex);
    if (matched) {
        return matched[1];
    }
    return fallback;
}

export function numArrToVal(arr: string[], limitSize: number = 3): number {
    return arr.slice(Math.max(arr.length - limitSize, 0)).reduce((x: number, curr: string) => {
        return x * 10 + +(curr.substr(1));
    }, 0)
}

export function arraysAreEqual(a1: string[], a2: string[]) {
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

export interface Config<T> {
    read(): Promise<T>;
    change(changer: (t: T) => void): Promise<void>;
    last(): T
}

export function newConfig<T extends Object>(initial: T, fileName: string): Config<T> {
    return new (class C implements Config<T> {
        private _read: boolean = false;
        private _data?: T;

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

        change(changer: (t: T) => void): Promise<void> {
            return this.read().then(data => {
                changer(data);
                return this.writeFileAsync();
            });
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