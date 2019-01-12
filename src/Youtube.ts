import * as curl from "./Curl";
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

            curl.get("https://www.googleapis.com/youtube/v3/videos?part=id%2C+snippet&key=" + k + "&id=" + ytbId)
                .then(
                    text => {
                        const dd = JSON.parse(text);
                        const snippet = dd.items[0]["snippet"];
                        accept({ 
                            title: snippet.title,
                            thumbnailUrl: snippet.thumbnails.default.url
                        });
                    }
                )
                .catch((err) => decline(err));
        } else {
            decline(new Error("Invalid URL: " + _url));
        }
    });
}
