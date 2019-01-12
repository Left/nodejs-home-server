import * as https from 'https';
import * as url from "url";

interface YoutubeTrack {
    title: string;
    thumbnailUrl: string;
}

export function getYoutubeInfo(_url: string): Promise<YoutubeTrack> {
    return new Promise<YoutubeTrack>((accept, decline) => {
        const u = new url.URL(_url);
        var ytbId: string|null|undefined;
        if (u.hostname === 'www.youtube.com') {
            ytbId = u.searchParams.get('v');
        } else if (u.hostname === 'youtu.be') {
            ytbId = u.pathname.split('/').filter(x => !!x)[0];
        }

        if (ytbId) {
            const k = Buffer.from("aHVNQUl6YVN5QlRCbnVqNktWMVRnUWhnMk1ZcVpyQjFFUWRtUzl5aHVN", 'base64').toString().substr(3);
            console.log(k);

            let options = {
                path:  "/youtube/v3/videos?part=id%2C+snippet&key=" + k + "&id=" + ytbId,
                host: "www.googleapis.com",
            };
            https.get(options, 
                (resp) => {
                let data = '';

                // A chunk of data has been recieved.
                resp.on('data', (chunk) => {
                    data += chunk;
                });

                // The whole response has been received. Print out the result.
                resp.on('end', () => {
                    const dd = JSON.parse(data);
                    const snippet = dd.items[0]["snippet"];
                    accept({ 
                        title: snippet.title,
                        thumbnailUrl: snippet.thumbnails.default.url
                    });
                });
            }).on("error", (err) => {
                decline(err);
            });
        } else {
            decline(new Error("Invalid URL: " + _url));
        }
    });
}
