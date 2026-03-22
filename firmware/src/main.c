/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal Zephyr application with shell support for QEMU x86,
 * designed to run inside QEMU compiled to WebAssembly.
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <version.h>

static int cmd_hello(const struct shell *sh, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    shell_print(sh, "Hello from Zephyr on QEMU x86 (WebAssembly)!");
    return 0;
}

static int cmd_info(const struct shell *sh, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    shell_print(sh, "Board:   %s", CONFIG_BOARD);
    shell_print(sh, "Zephyr:  %s", KERNEL_VERSION_STRING);
    shell_print(sh, "Built:   " __DATE__ " " __TIME__);
    return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(demo_cmds,
    SHELL_CMD(hello, NULL, "Print hello message", cmd_hello),
    SHELL_CMD(info, NULL, "Display system information", cmd_info),
    SHELL_SUBCMD_SET_END
);

SHELL_CMD_REGISTER(demo, &demo_cmds, "Demo commands", NULL);

int main(void)
{
    printk("*** Zephyr RTOS on QEMU x86 (WebAssembly) ***\n");
    printk("Type 'help' for available commands.\n");
    return 0;
}
