export declare const Platform: {
  OS: "web";
  select<T>(choices: { web?: T; default?: T; [os: string]: T | undefined }): T | undefined;
};
export declare const processColor: <T>(color: T) => T;
