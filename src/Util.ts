import * as child_process from "child_process";

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

export function isKeyAndNum(prefix: string[], arr: string[]): boolean {
    return arraysAreEqual(arr.slice(0, prefix.length), prefix) && 
        arr.slice(prefix.length).every(n => n.length == 2 && n[0] === 'n');
}