export type PtySize = {
    cols: number;
    rows: number;
};
export type PtyReplayFrame = {
    type: "resize";
    size: PtySize;
} | {
    type: "ready";
};
export declare function encodePtyReplay(frame: PtyReplayFrame): Uint8Array<ArrayBuffer>;
export declare function decodePtyReplay(data: ArrayBuffer): PtyReplayFrame | undefined;
