import { homedir } from 'node:os';
/** Mask only this user's home prefix, leaving the rest of each path intact. */
export function redactHomePaths(text) {
    const directory = homedir();
    // Detect the home path's syntax rather than the host running the exporter.
    // Windows is case-insensitive and accepts either separator, including mixed
    // paths from pnpm. Repeated separators also cover JSON-escaped NDJSON history.
    const windows = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(directory);
    const home = directory.replace(windows ? /[\\/]+$/ : /\/+$/, '');
    // A POSIX root home must not turn every absolute path into a home path.
    if (home === '')
        return text;
    const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const path = windows ? home.split(/[\\/]/).map(escape).join('[\\\\/]+') : escape(home);
    // Do not match a home embedded in another path/text, or a sibling such as
    // Alice-other or Alice.backup. File URLs still contain an absolute home;
    // quotes/brackets allow bare homes in log prose.
    const before = String.raw `(?:(?<![\p{L}\p{N}_./\\-])|(?<=\bfile://)|(?<=\bfile:///))`;
    // Trimming C:\ leaves C:, but only an absolute path belongs to that root.
    const after = windows && /^[a-z]:$/i.test(home)
        ? String.raw `(?=[\\/])`
        : windows ? String.raw `(?=$|[\\/\s"'\x60<>()[\]{},;:!?])` : String.raw `(?=$|[/\s"'\x60<>()[\]{},;:!?])`;
    return text.replace(new RegExp(before + path + after, windows ? 'giu' : 'gu'), '~');
}
