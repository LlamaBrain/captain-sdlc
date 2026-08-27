export declare function writeAuthorized(root: string, bucket: string, id: string, payload: unknown): Promise<void>;
export declare function readAuthorized<T>(root: string, bucket: string, id: string): Promise<T>;
