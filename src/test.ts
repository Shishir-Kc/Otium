import { downloadSong } from "./services/ytdlp";
import { uploadSong, signedUrl } from "./services/storage.ts";

console.log(signedUrl("covers/8f1fb92f-502d-4bda-b2f6-4b68027b3458.jpg"));

//
// const result = await downloadSong("https://youtu.be/m0NZ-aH0G1g?si=Uu8yER2il_n5qVoX");
// console.log(result["thumbnail"])
//
// const id = crypto.randomUUID();
// const oresult = await uploadSong(id, result["audio"], result["thumbnail"]);
// console.log(oresult);
// console.log(signedUrl(oresult.audio));
// console.log(result.cover ? signedUrl(result.cover) : "no cover uploaded");

