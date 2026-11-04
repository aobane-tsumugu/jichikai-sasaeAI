import { Hono } from "hono";
import type { AppEnv } from "../env";

// 束 1: 運用の画面（提供側の ID とパスワード）。/ops に付く。次の段で中身を足す。
export const opsRoutes = new Hono<AppEnv>();
