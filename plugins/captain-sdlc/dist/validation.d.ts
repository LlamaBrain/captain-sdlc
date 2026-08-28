export type SemVer = {
    major: number;
    minor: number;
    patch: number;
};
export declare function compileSafeRegex(pattern: string, flags?: string, label?: string): RegExp;
export declare function parseStrictSemVer(value: string): SemVer | null;
export declare function subjectVersion(subject: string): string | null;
