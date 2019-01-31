---
title: cn-agent
markdown2extras: tables, code-friendly
apisections: Task Agent HTTP API
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2019, Joyent, Inc.
-->

# cn-agent

The cn-agent runs on all TritonDC servers S(headnode and compute nodes)
and is primarly the agent by which CNAPI operates on those nodes via
a number of tasks (documented below).

WARNING: This doc is very incomplete. Most tasks are not documented.


# Task Agent HTTP API

### Error Response Object

    {
        "code": "InvalidArgument",
        "message": "Missing key 'task'"
    }

## CreateTask (POST /tasks)

Returns an object of type task. The task object returned is specified in the
query parameter `task`.

    POST /tasks?task=[task kind]

### CreateTask Responses

| Code | Description                     | Response                      |
| ---- | ------------------------------- | ----------------------------- |
| 200  | OK                              | Object of the given task type |
| 404  | RESOURCE NOT FOUND              | Error object                  |
| 409  | CONFLICT / InvalidArgumentError | Error object                  |
| 500  | SERVER ERROR                    | Error object                  |

### Inputs

| Param  | Type   | Required? | Description                            |
| ------ | ------ | --------- | -------------------------------------- |
| task   | string | required  | The kind of task to create             |
| params | Object | required  | Object containing parameters to update |

### CreateTask examples

Add metadata to a machine

    POST /tasks?task=machine_update
    {
        "params": {
          "server_uuid": "564df87e-d162-19e3-c46f-ab54c29b9e72",
          "uuid": "540fe764-0ccb-4208-ad41-522ed88767af",
          "set_internal_metadata": {
            "propertyOne": "false",
            "propertyTwo": "true"
          }
        }
    }

Remove a NIC from a machine

    POST /tasks?task=machine_update
    {
        "params": {
          "server_uuid": "564df87e-d162-19e3-c46f-ab54c29b9e72",
          "uuid": "540fe764-0ccb-4208-ad41-522ed88767af",
          "remove_nics": [
            "90:b8:d0:68:b9:1d"
          ],
          "task": "remove_nics",
          "vm_uuid": "540fe764-0ccb-4208-ad41-522ed88767af",
          "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
          "last_modified": "2015-08-18T05:28:38.000Z",
          "wantResolvers": true,
          "x-request-id": "acc59cf0-456a-11e5-8097-a3cd9f6470d6",
          "creator_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
          "origin": "adminui",
          "oldMacs": [
            "c2:ae:d4:6d:19:06",
            "90:b8:d0:68:b9:1d"
          ],
          "jobid": "6e9fd765-c8e7-41d6-8000-3d6354bb47d5",
          "resolvers": [
            "10.99.99.11"
          ],
          "remove_ips": [
            "10.88.88.6"
          ]
        }
    }

Add a NIC to a machine

    POST /tasks?task=machine_update
    {
        "params": {
          "server_uuid": "564df87e-d162-19e3-c46f-ab54c29b9e72",
          "uuid": "540fe764-0ccb-4208-ad41-522ed88767af",
          "networks": [
            {
              "ipv4_uuid": "54f38ed1-bf03-4c6c-8b56-6182145ffc80",
              "ipv4_count": 1,
              "uuid": "54f38ed1-bf03-4c6c-8b56-6182145ffc80"
            }
          ],
          "task": "add_nics",
          "vm_uuid": "540fe764-0ccb-4208-ad41-522ed88767af",
          "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
          "last_modified": "2015-08-18T05:23:58.000Z",
          "oldResolvers": [
            "10.99.99.11",
            "8.8.8.8",
            "8.8.4.4"
          ],
          "wantResolvers": true,
          "x-request-id": "8a82d1e0-4569-11e5-8097-a3cd9f6470d6",
          "creator_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
          "origin": "adminui",
          "jobid": "0360f3f7-b825-439b-ab76-ce00c285e56e",
          "add_nics": [
            {
              "belongs_to_type": "zone",
              "belongs_to_uuid": "540fe764-0ccb-4208-ad41-522ed88767af",
              "mac": "90:b8:d0:68:b9:1d",
              "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
              "primary": false,
              "state": "provisioning",
              "ip": "10.88.88.6",
              "gateway": "10.88.88.2",
              "mtu": 1500,
              "netmask": "255.255.255.0",
              "nic_tag": "external",
              "resolvers": [
                "8.8.8.8",
                "8.8.4.4"
              ],
              "vlan_id": 0,
              "network_uuid": "54f38ed1-bf03-4c6c-8b56-6182145ffc80"
            }
          ],
          "resolvers": [
            "10.99.99.11",
            "8.8.8.8",
            "8.8.4.4"
          ]
        }
    }


# Tasks

# Agent Tasks

## agents_uninstall

(Added in cn-agent v2.8.0.)

Uninstall the named agents. This finishes by updating installed agent info
in sysinfo (in the "SDC Agents" field) and in CNAPI (the server object's
"agents" field).

This task is idempotent, i.e. if you call it to remove an agent that is
already uninstalled, that will succeed. This allows callers to retry if
the task fails.

There is no guard against passing "cn-agent" as the agent name to remove. The
behaviour when passing this is undefined.

### Inputs

| Field  | Type    | Required? | Description                                                                                                                                                                                                                                                                                                                              |
| ------ | ------- | --------- | ----------- |
| agents | Array   | required  | The names of the agents to remove. |

# Machine Tasks

## machine_create_image

Called by CNAPI's
[VmImagesCreate](https://mo.joyent.com/docs/cnapi/master/#VmImagesCreate)
to create a new image from a prepared VM and publish it to the local DC's
IMGAPI.

### Inputs

| Field            | Type    | Required? | Description                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| compression      | String  | required  | The "compression" field as required by `imgadm create`. One of "none", "gzip" or "bzip2".                                                                                                                                                                                                                                                |
| uuid             | UUID    | required  | UUID of a prepared and stopped VM from which the image will be created.                                                                                                                                                                                                                                                                  |
| incremental      | Boolean | optional  | Whether to create an incremental image. Default is false.                                                                                                                                                                                                                                                                                |
| manifest         | Object  | required  | Manifest details for the image to be created. Those fields that are required are mentioned in this table. See [the image manifest docs](https://mo.joyent.com/docs/imgapi/master/#image-manifests) for full details. Some fields -- e.g. 'type', 'os' -- are inherited from the origin image (the image used to create the prepared VM). |
| manifest.uuid    | UUID    | required  | A newly generated UUID to be used for the created image.                                                                                                                                                                                                                                                                                 |
| manifest.owner   | UUID    | required  | The UUID of an existing user who will own the image.                                                                                                                                                                                                                                                                                     |
| manifest.name    | String  | required  | The name for the image to be created.                                                                                                                                                                                                                                                                                                    |
| manifest.version | String  | required  | The version for the image to be created.                                                                                                                                                                                                                                                                                                 |
| imgapi_url       | URL     | required  | The URL of the IMGAPI to which the image will be published. Typically this the DC's local IMGAPI at "http://imgapi.$domain"                                                                                                                                                                                                              |
