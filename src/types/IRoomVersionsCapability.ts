import { IRoomCapability} from "../client";
import { RoomVersionStability } from "./roomVersionStability";

export interface IRoomVersionsCapability {
    default: string;
    available: Record<string, RoomVersionStability>;
    "org.matrix.msc3244.room_capabilities"?: Record<string, IRoomCapability>; // MSC3244
}
