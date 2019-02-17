import * as https from 'https';
import * as http from 'http';
import * as url from "url";
import * as zlib from "zlib";

export function get(_url: string): Promise<string> {
    return new Promise<string>((accept, decline) => {
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
                get(resp.headers.location)
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

                let data = '';
        
                // A chunk of data has been recieved.
                pipe.on('data', (chunk) => {
                    data += chunk;
                });
        
                // The whole response has been received. Print out the result.
                pipe.on('end', () => {
                    accept(data);
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