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
