import test from "node:test";
import assert from "node:assert/strict";
import {
  validateLocalCompose,
  validateLocalInspection,
} from "../server/local-deployment.js";
const service = () => ({
  environment: {
    LOCAL_OWNER_MODE: "trusted-loopback",
    APP_ORIGIN: "http://localhost:9876",
    HOST: "0.0.0.0",
    PORT: "8787",
  },
  ports: [
    { target: 8787, published: "9876", host_ip: "127.0.0.1", protocol: "tcp" },
  ],
});
void test("trusted deployment preflight requires explicit mode and only exact127 publication with matching canonical port", () => {
  assert.doesNotThrow(() =>
    validateLocalCompose({ services: { sticker: service() } }),
  );
  for (const patch of [
    {
      ports: [
        {
          target: 8787,
          published: "9876",
          host_ip: "0.0.0.0",
          protocol: "tcp",
        },
      ],
    },
    { ports: [{ target: 8787, published: "9876", protocol: "tcp" }] },
    { network_mode: "host" },
    {
      ports: [
        ...service().ports,
        { target: 9999, published: "9999", host_ip: "127.0.0.1" },
      ],
    },
    {
      environment: {
        ...service().environment,
        APP_ORIGIN: "http://localhost:8787",
      },
    },
    { environment: { ...service().environment, LOCAL_OWNER_MODE: "off" } },
  ])
    assert.throws(() =>
      validateLocalCompose({
        services: { sticker: { ...service(), ...patch } },
      }),
    );
});
void test("actual inspection must preserve loopback publication; declarations alone are insufficient", () => {
  const good = {
    ports: { "8787/tcp": [{ HostIp: "127.0.0.1", HostPort: "9876" }] },
    networkMode: "sticker_default",
  };
  assert.doesNotThrow(() => {
    validateLocalInspection(good, 9876);
  });
  for (const value of [
    { ...good, networkMode: "host" },
    { ...good, ports: { "8787/tcp": [{ HostIp: "::", HostPort: "9876" }] } },
    {
      ...good,
      ports: { "8787/tcp": [{ HostIp: "127.0.0.1", HostPort: "9877" }] },
    },
    { ...good, ports: { "8787/tcp": null } },
    {
      ...good,
      ports: {
        ...good.ports,
        "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "9000" }],
      },
    },
  ])
    assert.throws(() => {
      validateLocalInspection(value, 9876);
    });
});
