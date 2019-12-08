import * as https from 'https';
import * as http from 'http';
import * as url from "url";
import * as zlib from "zlib";

export async function get(_url: string): Promise<string> {
    const data = await getBin(_url);
    return data.body.toString();
}

export type BinResponse = { body: Buffer, contentType?: string }

export function getBin(_url: string): Promise<BinResponse> {
    return new Promise<BinResponse>((accept, decline) => {
        const u = new url.URL(_url);
            
        let options = {
            protocol: u.protocol,
            port: +u.port,
            path: u.pathname + u.search,
            host: u.hostname,
            headers: {
                'Accept-Encoding': 'gzip'//,
                // 'Cache-Control': 'no-cache',
                // 'Pragma': 'no-cache'
            }
        };

        const process = (resp: http.IncomingMessage) => {
            if ((resp.statusCode == 302 || resp.statusCode == 301) && resp.headers.location) {
                getBin(resp.headers.location)
                    .then(data => accept(data))
                    .catch(err => decline(err));
            } else {
                const gzip = resp.headers['content-encoding'] === 'gzip';

                var gunzip = zlib.createGunzip();            
                let pipe;
                if (gzip) {
                    pipe = resp.pipe(gunzip);
                } else {
                    pipe = resp;
                }

                let data: Buffer[] = [];
        
                // A chunk of data has been recieved.
                pipe.on('data', (chunk) => {
                    if (typeof(chunk) === 'string') {
                        data.push(Buffer.from(chunk));
                    } else {
                        data.push(chunk);   
                    }
                });
        
                // The whole response has been received. Print out the result.
                pipe.on('end', () => {
                    accept({ body: Buffer.concat(data), contentType: resp.headers["content-type"] });
                });
            }
        };
   
        if (u.protocol.indexOf('https') != -1) {
            https.get(options, process).on("error", (err: Error) => {
                decline(err);
            });
        } else {
            http.get(options, process).on("error", (err: Error) => {
                decline(err);
            });
        }
    });
}