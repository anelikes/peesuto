#include <stdio.h>
#include <sysexits.h>
#include <unistd.h>

/* Keep the daemon and its render workers in a private process group. execv
 * preserves this PID, stdio, working directory, and environment, so the Swift
 * owner can terminate the entire job using kill(-processIdentifier, signal).
 * This launcher intentionally never logs arguments: they may contain secrets.
 */
int main(int argc, char *argv[]) {
    if (argc < 3) {
        fputs("Core launcher requires an executable and daemon entry point.\n", stderr);
        return EX_USAGE;
    }

    if (setpgid(0, 0) != 0) {
        fputs("Core launcher could not create an isolated process group.\n", stderr);
        return EX_OSERR;
    }

    execv(argv[1], argv + 1);
    fputs("Core launcher could not start the daemon.\n", stderr);
    return 126;
}
