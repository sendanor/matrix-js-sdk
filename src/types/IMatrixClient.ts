import { SessionStore, Store } from "../client";
import { Crypto } from "../crypto";
import { ICapabilities } from "./ICapabilities";
import { User } from "../models/user";
import { MatrixHttpApi } from "../http-api";
import { EventMapper, MapperOpts } from "../event-mapper";
import { DeviceInfo } from "../crypto/deviceinfo";

/**
 * Interface to remove circular dependency from models/room.ts
 */
export interface IMatrixClient {

    sessionStore: SessionStore;
    crypto: Crypto;
    store: Store;
    http: MatrixHttpApi;

    getUserId(): string;
    getUser(userId: string): User;
    getCapabilities(fresh ?: boolean): Promise<ICapabilities>;
    getEventMapper(options?: MapperOpts): EventMapper;
    isRoomEncrypted(roomId: string): boolean;
    getStoredDevicesForUser(userId: string): DeviceInfo[];

}
