/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal Zephyr application with shell support for QEMU x86,
 * designed to run inside QEMU compiled to WebAssembly.
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <version.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/dhcpv4.h>

/* Print the address DHCP hands out, so the console shows when the network
 * is up (the browser carries the NIC's frames to relaynet). */
static struct net_mgmt_event_callback dhcp_cb;

static void on_ipv4_addr_add(struct net_mgmt_event_callback *cb,
                             uint64_t event, struct net_if *iface)
{
    ARG_UNUSED(cb);
    if (event != NET_EVENT_IPV4_ADDR_ADD) {
        return;
    }
    struct net_if_ipv4 *ipv4 = iface->config.ip.ipv4;
    if (ipv4 == NULL) {
        return;
    }
    ARRAY_FOR_EACH(ipv4->unicast, i) {
        struct net_if_addr *a = &ipv4->unicast[i].ipv4;
        char buf[NET_IPV4_ADDR_LEN];

        if (!a->is_used || a->addr_type != NET_ADDR_DHCP) {
            continue;
        }
        printk("IPv4 address: %s\n",
               net_addr_ntop(AF_INET, &a->address.in_addr, buf, sizeof(buf)));
    }
}

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

    struct net_if *iface = net_if_get_default();

    if (iface != NULL) {
        net_mgmt_init_event_callback(&dhcp_cb, on_ipv4_addr_add,
                                     NET_EVENT_IPV4_ADDR_ADD);
        net_mgmt_add_event_callback(&dhcp_cb);
        net_dhcpv4_start(iface);
    }
    return 0;
}
