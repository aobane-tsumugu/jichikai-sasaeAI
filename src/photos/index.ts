import type { Bundle } from "../core/bundle";
import { reportPhotoAdmin, photoPublic } from "./pages";
import { photoProvider } from "./provider";
export const photos: Bundle = { admin: reportPhotoAdmin, pub: photoPublic, hooks: photoProvider };
