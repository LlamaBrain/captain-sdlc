export function compileSafeRegex(pattern, flags = "", label = "regular expression") {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 512)
        throw new Error(`${label} is empty or too long`);
    const unsupported = /\\[1-9]|\\k<|\(\?(?:[=!]|<[=!])|\(\?>|\(\?\(|\([^)]*(?:\*|\+|\{\d+,?\d*\})[^)]*\)(?:\*|\+|\{\d+,?\d*\})|\.(?:\*|\+|\{\d+,?\d*\})/;
    if (unsupported.test(pattern))
        throw new Error(`${label} is an unsafe regular expression`);
    const declarative = pattern.replace(/\(\?<[_A-Za-z][_A-Za-z0-9]*>/g, "(").replace(/\(\?:/g, "(");
    for (let index = 0; index < declarative.length; index++)
        if ((declarative[index] === "|" || declarative[index] === "?") && (index === 0 || declarative[index - 1] !== "\\"))
            throw new Error(`${label} is an unsafe regular expression`);
    try {
        return new RegExp(pattern, flags);
    }
    catch {
        throw new Error(`${label} is not a valid regular expression`);
    }
}
export function parseStrictSemVer(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    if (!match)
        return null;
    const numbers = match.slice(1).map(Number);
    if (numbers.some(number => !Number.isSafeInteger(number)))
        return null;
    return { major: numbers[0], minor: numbers[1], patch: numbers[2] };
}
export function subjectVersion(subject) {
    const value = subject.match(/\(v([^()]+)\)$/)?.[1];
    return value && parseStrictSemVer(value) ? value : null;
}
