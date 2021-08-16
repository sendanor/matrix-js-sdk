import { IRoomVersionsCapability } from "./IRoomVersionsCapability";
import { IChangePasswordCapability } from "../client";

export interface ICapabilities {
    [key: string]: any;

    "m.change_password"?: IChangePasswordCapability;
    "m.room_versions"?: IRoomVersionsCapability;
}
