// @ts-nocheck
/* eslint-disable no-restricted-syntax */
import swc from "@swc/core";
import { execFileSync, execSync } from "child_process";
import crypto from "crypto";
import { build } from "esbuild";
import globalPlugin from "esbuild-plugin-globals";
import path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs-parser";

import { printBuildSuccess } from "./util.mjs";
import { readFile } from "fs/promises";

/** @type string[] */
const metroDeps = await (async () => {
    const ast = await swc.parseFile(path.resolve("./shims/depsModule.ts"));
    return ast.body.at(-1).expression.right.properties.map(p => p.key.value);
})();

const args = yargs(process.argv.slice(2));
const {
    "release-branch": releaseBranch,
    "build-minify": buildMinify,
    "dev": dev
} = args;

let context = null;

/** @type {import("esbuild").BuildOptions} */
const config = {
    entryPoints: ["src/entry.ts"],
    bundle: true,
    outfile: "dist/revenge.js",
    format: "iife",
    splitting: false,
    external: [],
    supported: {
        // Hermes does not actually support const and let, even though it syntactically
        // accepts it, but it's treated just like 'var' and causes issues
        "const-and-let": false
    },
    footer: {
        js: "//# sourceURL=revenge"
    },
    loader: {
        ".png": "dataurl"
    },
    define: {
        window: "globalThis",
        __DEV__: dev ?? JSON.stringify(releaseBranch !== "main")
    },
    inject: ["./shims/asyncIteratorSymbol.js", "./shims/promiseAllSettled.js"],
    legalComments: "none",
    alias: {
        "!bunny-deps-shim!": "./shims/depsModule.ts",
        "spitroast": "./node_modules/spitroast",
        "react/jsx-runtime": "./shims/jsxRuntime"
    },
    plugins: [
        globalPlugin({
            ...metroDeps.reduce((obj, key) => {
                obj[key] = `require("!bunny-deps-shim!")[${JSON.stringify(key)}]`;
                return obj;
            }, {})
        }),
        {
            name: "swc",
            setup(build) {
                build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
                    const result = await swc.transformFile(args.path, {
                        jsc: {
                            externalHelpers: true,
                            transform: {
                                constModules: {
                                    globals: {
                                        "bunny-build-info": {
                                            version: `"${context.hash}-${releaseBranch ?? "local"}"`
                                        }
                                    }
                                },
                                react: {
                                    runtime: "automatic"
                                }
                            },
                        },
                        // https://github.com/facebook/hermes/blob/3815fec63d1a6667ca3195160d6e12fee6a0d8d5/doc/Features.md
                        // https://github.com/facebook/hermes/issues/696#issuecomment-1396235791
                        env: {
                            targets: "fully supports es6",
                            include: [
                                "transform-block-scoping",
                                "transform-classes",
                                "transform-async-to-generator",
                                "transform-async-generator-functions"
                            ],
                            exclude: [
                                "transform-parameters",
                                "transform-template-literals",
                                "transform-exponentiation-operator",
                                "transform-named-capturing-groups-regex",
                                "transform-nullish-coalescing-operator",
                                "transform-object-rest-spread",
                                "transform-optional-chaining",
                                "transform-logical-assignment-operators"
                            ]
                        },
                    });

                    return { contents: result.code };
                });
            }
        }
    ]
};

export async function buildBundle(overrideConfig = {}) {
    context = {
        hash: releaseBranch ? execSync("git rev-parse --short HEAD").toString().trim() : crypto.randomBytes(8).toString("hex").slice(0, 7)
    };

    const initialStartTime = performance.now();
    await build({ ...config, ...overrideConfig });

    const paths = {
        win32: 'win64-bin/hermesc.exe',
        darwin: 'osx-bin/hermesc',
        linux: 'linux64-bin/hermesc',
    }

    if (!(process.platform in paths))
        throw new Error(`Unsupported platform: ${process.platform}`)

    const sdksDir = './node_modules/react-native/sdks'
    const binPath = `${sdksDir}/hermesc/${paths[process.platform]}`

    const actualFile = overrideConfig.outfile ?? config.outfile;

    execFileSync(binPath, ['-finline', '-strict', '-O', '-g1', '-reuse-prop-cache', '-optimized-eval', '-emit-binary', '-Wno-undefined-variable', '-out', actualFile], {
        input: await readFile(actualFile),
        stdio: 'pipe'
    });

    return {
        config,
        context,
        timeTook: performance.now() - initialStartTime
    };
}

const pathToThisFile = path.resolve(fileURLToPath(import.meta.url));
const pathPassedToNode = path.resolve(process.argv[1]);
const isThisFileBeingRunViaCLI = pathToThisFile.includes(pathPassedToNode);

if (isThisFileBeingRunViaCLI) {
    const { timeTook } = await buildBundle();

    printBuildSuccess(
        context.hash,
        releaseBranch,
        timeTook
    );

    if (buildMinify) {
        const { timeTook } = await buildBundle({
            minifyIdentifiers: true,
            outfile: config.outfile.replace(/\.js$/, ".min.js")
        });

        printBuildSuccess(
            context.hash,
            releaseBranch,
            timeTook,
            true
        );
    }
}
