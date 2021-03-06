'use strict';

import * as vscode from 'vscode';
import { Shell, ShellResult } from '../../../shell';
import { Host } from '../../../host';
import { FS } from '../../../fs';
import * as binutil from '../../../binutil';
import { Errorable } from '../../../errorable';
import { fromShellExitCodeOnly, Diagnostic } from '../../../wizard';

export class MinikubeInfo {
    readonly running: boolean;
    readonly cluster: string;
    readonly kubectl: string;
}

export class MinikubeOptions {
    readonly vmDriver: string;
    readonly additionalFlags: string;
}

export interface Minikube {
    checkPresent(mode: CheckPresentMode): Promise<boolean>;
    isRunnable(): Promise<Errorable<Diagnostic>>;
    start(options: MinikubeOptions): Promise<void>;
    stop(): Promise<void>;
    status(): Promise<MinikubeInfo>;
}

export function create(host: Host, fs: FS, shell: Shell, installDependenciesCallback: () => void): Minikube {
    return new MinikubeImpl(host, fs, shell, installDependenciesCallback, false);
}

// TODO: these are the same as we are using for Draft (and kubectl?) -
// we really need to unify them (and the designs).

export enum CheckPresentMode {
    Alert,
    Silent
}

interface Context {
    readonly host: Host;
    readonly fs: FS;
    readonly shell: Shell;
    readonly installDependenciesCallback: () => void;
    binFound: boolean;
    binPath: string;
}

class MinikubeImpl implements Minikube {
    private readonly context: Context;

    constructor(host: Host, fs: FS, shell: Shell, installDependenciesCallback: () => void, toolFound: boolean) {
        this.context = { host: host, fs: fs, shell: shell, installDependenciesCallback: installDependenciesCallback, binFound: toolFound, binPath: 'minikube' };
    }

    checkPresent(mode: CheckPresentMode): Promise<boolean> {
        return checkPresent(this.context, mode);
    }

    isRunnable(): Promise<Errorable<Diagnostic>> {
        return isRunnableMinikube(this.context);
    }

    start(options: MinikubeOptions): Promise<void> {
        return startMinikube(this.context, options);
    }

    stop(): Promise<void> {
        return stopMinikube(this.context);
    }

    status(): Promise<MinikubeInfo> {
        return minikubeStatus(this.context);
    }
}

async function isRunnableMinikube(context: Context): Promise<Errorable<Diagnostic>> {
    if (!await checkPresent(context, CheckPresentMode.Alert)) {
        return { succeeded: false, error: ['Minikube is not installed'] };
    }

    const sr = await context.shell.exec(`${context.binPath} help`);
    return fromShellExitCodeOnly(sr);
}

let minikubeStatusBarItem;

function getStatusBar(): vscode.StatusBarItem {
    if (!minikubeStatusBarItem) {
        minikubeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    }
    return minikubeStatusBarItem;
}

async function startMinikube(context: Context, options: MinikubeOptions): Promise<void> {
    if (!await checkPresent(context, CheckPresentMode.Alert)) {
        return;
    }
    const item = getStatusBar();
    item.text = 'minikube-starting';
    item.show();

    const status = await minikubeStatus(context);
    if (status.running) {
        vscode.window.showWarningMessage('Minikube cluster is already started.');
        return;
    }

    let flags = options.additionalFlags ? options.additionalFlags : '';
    if (options.vmDriver && options.vmDriver.length > 0) {
        flags += ` --vm-driver=${options.vmDriver} `;
    }
    context.shell.exec(`${context.binPath} ${flags} start`).then((result: ShellResult) => {
        if (result.code === 0) {
            vscode.window.showInformationMessage('Cluster started.');
            item.text = 'minikube-running';
        } else {
            vscode.window.showErrorMessage(`Failed to start cluster ${result.stderr}`);
            item.hide();
        }
    }).catch((err) => {
        item.hide();
        vscode.window.showErrorMessage(`Failed to start cluster: ${err}`);
    });
}

async function stopMinikube(context: Context): Promise<void> {
    if (!await checkPresent(context, CheckPresentMode.Alert)) {
        return;
    }
    const item = getStatusBar();
    item.text = 'minikube-stopping';
    item.show();

    const status = await minikubeStatus(context);
    if (!status.running) {
        vscode.window.showWarningMessage('Minikube cluster is already stopped.');
        return;
    }

    context.shell.exec(`${context.binPath} stop`).then((result: ShellResult) => {
        if (result.code === 0) {
            vscode.window.showInformationMessage('Cluster stopped.');
            item.hide();
        } else {
            vscode.window.showErrorMessage(`Error stopping cluster ${result.stderr}`);
            item.hide();
        }
    }).catch((err) => {
        vscode.window.showErrorMessage(`Error stopping cluster: ${err}`);
        item.hide();
    });
}

async function minikubeStatus(context: Context): Promise<MinikubeInfo> {
    if (!await checkPresent(context, CheckPresentMode.Silent)) {
        throw new Error('minikube executable could not be found!');
    }

    const result = await context.shell.exec(
        `${context.binPath} status --format '["{{.MinikubeStatus}}","{{.ClusterStatus}}","{{.KubeconfigStatus}}"]'`);
    if (result.stderr.length === 0) {
        const obj = JSON.parse(result.stdout);
        return {
            running: 'Stopped' !== obj[0],
            cluster: obj[1],
            kubectl: obj[2],
        } as MinikubeInfo;
    }
    throw new Error(`failed to get status: ${result.stderr}`);
}

async function checkPresent(context: Context, mode: CheckPresentMode): Promise<boolean> {
    if (context.binFound) {
        return true;
    }

    return await checkForMinikubeInternal(context, mode);
}

async function checkForMinikubeInternal(context: Context, mode: CheckPresentMode): Promise<boolean> {
    const binName = 'minikube';
    const bin = context.host.getConfiguration('vs-kubernetes')[`vs-kubernetes.${binName}-path`];

    const inferFailedMessage = 'Could not find "minikube" binary.';
    const configuredFileMissingMessage = bin + ' does not exist!';
    return binutil.checkForBinary(context, bin, binName, inferFailedMessage, configuredFileMissingMessage, mode === CheckPresentMode.Alert);
}
