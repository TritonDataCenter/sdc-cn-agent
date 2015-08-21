---
title: Provisioner Agent
markdown2extras: tables, code-friendly
apisections:
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# Provisioner Agent

The provisioner agent runs on all SDC nodes (headnode and compute nodes)
and is primarly the agent by which CNAPI operates on those nodes via
a number of tasks (documented below). Provisioner chiefly operates over AMQP,
but some effort has been put into making tasks as transport agnostic as
possible.

When the main process starts up, it connects to AMQP. It will then create
queues on which it will receive messages. Each queue can handle one or more
tasks, where type may be something like `machine_create`, `machine_reboot`,
etc. Each queue is given a upper limit of tasks to be concurrently
executed.


# Provisioner Messages

*Note*: ${var} denotes you should substitue that value with something
meaningful.


## Incoming messages

To start a new task send a message to this routing key:

    ${agent}.${node_uuid}.task.${task}

Payload:

    {
        task_id: 'my_unique_task_id',
        client_id:  'my_unique_client_id'
    }

Keys:

`task_id`:

> A unique id to relate this request to any tasks, events and steps.

`client_id`:

> A unique id that will identify the initiator of the task. This is
> used in outgoing messages we wish the sender to get, so they can bind a
> routing key to a queue ahead of time.


## Outgoing

### Steps

Step messages indicate the entry/exit of a task step. If an event's name is
prefixed with start: or end: it means it was a step and the event name after
the colon (:) was the name of the step.

    provisioner.${node_uuid}.event.start:prec_check.${client_id}.${task_id}
    provisioner.${node_uuid}.event.end:prec_check.${client_id}.${task_id}
    provisioner.${node_uuid}.event.start:ensure_dataset_present.${client_id}.${task_id}
    provisioner.${node_uuid}.event.end:ensure_dataset_present.${client_id}.${task_id}


### Events

Events messages indicate may milestone in a task, or that something has
happened. This might be that a certain % progress has been reached, that we
have started or finished a step, or something that doesn't necessarily correlate to the entry or exit of a step.

    provisioner.${node_uuid}.event.screenshot.${client_id}.${task_id}


### Progress

Indicates from 0-100 how far along this task is, with 0 being just started and
100 being finished.

    provisioner.${node_uuid}.event.progress.${client_id}.${task_id}

## Sample Interaction

This is what a request to provision a VM on a compute node might look like.

Tasks begin with a request originating from a "client". Tasks end when the
agent sends a "finish" event.

E.g. for the `machine_create` task, it might look like this:

    --> provisiner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.task.machine_create

    {
        client_id:  '5699633f',
        task_id: '11999575',

        <vm parameters>
    }

Provisioner indicates it has started the task:

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.start.5699633f.11999575
    {}

Provisioner begins to execute steps and emit progress events:

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.progress.5699633f.11999575
    { value: 0 }

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.start:pre_check.5699633f.11999575
    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.end:pre_check.5699633f.11999575

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.progress.5699633f.11999575
    { value: 20 }

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.start:ensure_dataset_present.5699633f.11999575
    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.end:ensure_dataset_present.5699633f.11999575

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.progress.5699633f.11999575
    { value: 30 }

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.start:fetch_dataset.5699633f.11999575
    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.end:fetch_dataset.5699633f.11999575

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.progress.5699633f.11999575
    { value: 50 }

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.start:create_machine.5699633f.11999575
    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.end:create_machine.5699633f.11999575

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.progress.5699633f.11999575
    { value: 100 }

Finally the `finish` event message is sent.

    <-- provisioner.564dba97-54f6-4d3d-50d4-fe51cb228cc8.event.finish.5699633f.11999575
    {
        <result parameters>
    }

# Task Agent HTTP API

## Error Response Object

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

List ZFS datasets on a machine

    POST /tasks?task=zfs_list_datasets
    {
      "params": {
      }
    }

## GetImage (GET /images/:uuid)

Returns an image manifest object.
GET /images/[image uuid]

### GetImage Responses

| Code | Description                     | Response                      |
| ---- | ------------------------------- | ----------------------------- |
| 200  | OK                              | Image manifest object         |
| 404  | RESOURCE NOT FOUND              | Error object                  |
| 500  | SERVER ERROR                    | Error object                  |

## GetImage example

    GET /images/fd2cc906-8938-11e3-beab-4359c665ac99

## GetImageFile (GET /images/:uuid/file)

Returns an image file.
GET /images/[image uuid]/file

### GetImageFile Responses

| Code | Description                     | Response                      |
| ---- | ------------------------------- | ----------------------------- |
| 200  | OK                              | Image manifest object         |
| 404  | RESOURCE NOT FOUND              | Error object                  |
| 500  | SERVER ERROR                    | Error object                  |

## GetImageFile example

    GET /images/fd2cc906-8938-11e3-beab-4359c665ac99/file

# Tasks

# Machine Tasks

## machine_create
## machine_destroy
## machine_boot
## machine_shutdown
## machine_reboot

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



# ZFS Tasks

Tasks for interacting directly with `zfs`.

## zfs_clone_dataset
## zfs_create_dataset
## zfs_destroy_dataset
## zfs_get_properties
## zfs_set_properties
## zfs_list_datasets
## zfs_rename_dataset
## zfs_rollback_dataset
## zfs_snapshot_dataset
## zfs_list_pools


# Metering Tasks

TODO


# Operator Guide

TODO: examples using taskadm, logs location (separated out task logs), etc
