import { ISecretStorageKeyInfo } from "../crypto/api";
import { DeviceTrustLevel } from "../crypto/CrossSigning";

export interface ICryptoCallbacks {
    getCrossSigningKey?: (keyType: string, pubKey: string) => Promise<Uint8Array>;
    saveCrossSigningKeys?: (keys: Record<string, Uint8Array>) => void;
    shouldUpgradeDeviceVerifications?: (
        users: Record<string, any>
    ) => Promise<string[]>;
    getSecretStorageKey?: (
        keys: {keys: Record<string, ISecretStorageKeyInfo>}, name: string
    ) => Promise<[ string, Uint8Array ] | null>;
    cacheSecretStorageKey?: (
        keyId: string, keyInfo: ISecretStorageKeyInfo, key: Uint8Array
    ) => void;
    onSecretRequested?: (
        userId: string, deviceId: string,
        requestId: string, secretName: string, deviceTrust: DeviceTrustLevel
    ) => Promise<string>;
    getDehydrationKey?: (
        keyInfo: ISecretStorageKeyInfo,
        checkFunc: (Uint8Array) => void
    ) => Promise<Uint8Array>;
    getBackupKey?: () => Promise<Uint8Array>;
}
