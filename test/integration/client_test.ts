import { assert } from 'chai';
import * as sinon from 'sinon';
import yorkie, {
  Counter,
  SyncMode,
  DocumentSyncResultType,
  DocEventType,
  ClientEventType,
} from '@yorkie-js-sdk/src/yorkie';
import { waitStubCallCount } from '@yorkie-js-sdk/test/helper/helper';
import {
  toDocKey,
  testRPCAddr,
  withTwoClientsAndDocuments,
} from '@yorkie-js-sdk/test/integration/integration_helper';

describe('Client', function () {
  it('Can be activated, deactivated', async function () {
    const clientKey = `${this.test!.title}-${new Date().getTime()}`;
    const clientWithKey = new yorkie.Client(testRPCAddr, {
      key: clientKey,
      syncLoopDuration: 50,
      reconnectStreamDelay: 1000,
    });
    assert.isFalse(clientWithKey.isActive());
    await clientWithKey.activate();
    assert.isTrue(clientWithKey.isActive());
    assert.equal(clientKey, clientWithKey.getKey());
    await clientWithKey.deactivate();
    assert.isFalse(clientWithKey.isActive());

    const clientWithoutKey = new yorkie.Client(testRPCAddr);
    assert.isFalse(clientWithoutKey.isActive());
    await clientWithoutKey.activate();
    assert.isTrue(clientWithoutKey.isActive());
    assert.isString(clientWithoutKey.getKey());
    assert.lengthOf(clientWithoutKey.getKey(), 36);
    await clientWithoutKey.deactivate();
    assert.isFalse(clientWithoutKey.isActive());
  });

  it('Can handle sync', async function () {
    type TestDoc = { k1: string; k2: string; k3: string };
    await withTwoClientsAndDocuments<TestDoc>(async (c1, d1, c2, d2) => {
      const spy = sinon.spy();
      const unsub = d2.subscribe(spy);

      assert.equal(0, spy.callCount);

      d1.update((root) => {
        root['k1'] = 'v1';
      });
      await c1.sync();
      await c2.sync();
      assert.equal(1, spy.callCount);

      d1.update((root) => {
        root['k2'] = 'v2';
      });
      await c1.sync();
      await c2.sync();
      assert.equal(2, spy.callCount);

      unsub();

      d1.update((root) => {
        root['k3'] = 'v3';
      });
      await c1.sync();
      await c2.sync();
      assert.equal(2, spy.callCount);
    }, this.test!.title);
  });

  it('Can recover from temporary disconnect (manual sync)', async function () {
    await withTwoClientsAndDocuments<{ k1: string }>(async (c1, d1, c2, d2) => {
      // Normal Condition
      d2.update((root) => {
        root['k1'] = 'undefined';
      });

      await c2.sync();
      await c1.sync();
      assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

      // Simulate network error
      const xhr = sinon.useFakeXMLHttpRequest();
      xhr.onCreate = (req) => {
        req.respond(
          400,
          {
            'Content-Type': 'application/grpc-web-text+proto',
          },
          '',
        );
      };

      d2.update((root) => {
        root['k1'] = 'v1';
      });

      await c2.sync().catch((err) => {
        assert.equal(err.message, 'INVALID_STATE_ERR - 0');
      });
      await c1.sync().catch((err) => {
        assert.equal(err.message, 'INVALID_STATE_ERR - 0');
      });
      assert.equal(d1.toSortedJSON(), '{"k1":"undefined"}');
      assert.equal(d2.toSortedJSON(), '{"k1":"v1"}');

      // Back to normal condition
      xhr.restore();

      await c2.sync();
      await c1.sync();
      assert.equal(d1.toSortedJSON(), d2.toSortedJSON());
    }, this.test!.title);
  });

  it('Can recover from temporary disconnect (realtime sync)', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    const c2 = new yorkie.Client(testRPCAddr);
    await c1.activate();
    await c2.activate();

    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ k1: string }>(docKey);
    const d2 = new yorkie.Document<{ k1: string }>(docKey);

    await c1.attach(d1);
    await c2.attach(d2);

    const c1Events: Array<string> = [];
    const c2Events: Array<string> = [];
    const d1Events: Array<string> = [];
    const d2Events: Array<string> = [];

    const stubC1 = sinon.stub().callsFake((event) => {
      c1Events.push(
        event.type === ClientEventType.DocumentSynced
          ? event.value
          : event.type,
      );
    });
    const stubC2 = sinon.stub().callsFake((event) => {
      c2Events.push(
        event.type === ClientEventType.DocumentSynced
          ? event.value
          : event.type,
      );
    });
    const stubD1 = sinon.stub().callsFake((event) => {
      d1Events.push(event.type);
    });
    const stubD2 = sinon.stub().callsFake((event) => {
      d2Events.push(event.type);
    });

    const unsub1 = {
      client: c1.subscribe(stubC1),
      doc: d1.subscribe(stubD1),
    };
    const unsub2 = {
      client: c2.subscribe(stubC2),
      doc: d2.subscribe(stubD2),
    };

    // Normal Condition
    d2.update((root) => {
      root['k1'] = 'undefined';
    });

    await waitStubCallCount(stubD2, 1); // d2 should be able to update
    assert.equal(d2Events.pop(), DocEventType.LocalChange);
    await waitStubCallCount(stubD1, 1); // d1 should be able to receive d2's update
    assert.equal(d1Events.pop(), DocEventType.RemoteChange);
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

    // Simulate network error
    const xhr = sinon.useFakeXMLHttpRequest();
    xhr.onCreate = (req) => {
      req.respond(
        400,
        {
          'Content-Type': 'application/grpc-web-text+proto',
        },
        '',
      );
    };

    d2.update((root) => {
      root['k1'] = 'v1';
    });

    await waitStubCallCount(stubD2, 2); // d2 should be able to update
    assert.equal(d2Events.pop(), DocEventType.LocalChange);
    await waitStubCallCount(stubC2, 2); // c2 should fail to sync
    assert.equal(
      c2Events.pop(),
      DocumentSyncResultType.SyncFailed,
      'c2 sync fail',
    );

    await c1.sync().catch((err) => {
      assert.equal(err.message, 'INVALID_STATE_ERR - 0'); // c1 should also fail to sync
    });
    assert.equal(
      c1Events.pop(),
      DocumentSyncResultType.SyncFailed,
      'c1 sync fail',
    );
    assert.equal(d1.toSortedJSON(), '{"k1":"undefined"}');
    assert.equal(d2.toSortedJSON(), '{"k1":"v1"}');

    // Back to normal condition
    xhr.restore();

    await waitStubCallCount(stubC2, 3); // wait for c2 to sync
    assert.equal(c2Events.pop(), DocumentSyncResultType.Synced, 'c2 sync');
    await waitStubCallCount(stubC1, 5);
    assert.equal(c1Events.pop(), DocumentSyncResultType.Synced, 'c1 sync');
    await waitStubCallCount(stubD1, 2);
    assert.equal(d1Events.pop(), DocEventType.RemoteChange); // d1 should be able to receive d2's update
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

    unsub1.client();
    unsub2.client();
    unsub1.doc();
    unsub2.doc();

    await c1.detach(d1);
    await c2.detach(d2);

    await c1.deactivate();
    await c2.deactivate();
  });

  it('Can change realtime sync', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    const c2 = new yorkie.Client(testRPCAddr);
    await c1.activate();
    await c2.activate();

    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ version: string }>(docKey);
    const d2 = new yorkie.Document<{ version: string }>(docKey);

    // 01. c1 and c2 attach the doc with manual sync mode.
    //     c1 updates the doc, but c2 does't get until call sync manually.
    await c1.attach(d1, { isRealtimeSync: false });
    await c2.attach(d2, { isRealtimeSync: false });
    d1.update((root) => {
      root.version = 'v1';
    });
    assert.notEqual(d1.toSortedJSON(), d2.toSortedJSON());
    await c1.sync();
    await c2.sync();
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

    // 02. c2 changes the sync mode to realtime sync mode.
    const c2Events: Array<string> = [];
    const stubC2 = sinon.stub().callsFake((event) => {
      c2Events.push(event.type);
    });
    const unsub1 = c2.subscribe(stubC2);
    await c2.resume(d2);
    d1.update((root) => {
      root.version = 'v2';
    });
    await c1.sync();
    await waitStubCallCount(stubC2, 2);
    assert.equal(c2Events.pop(), ClientEventType.DocumentSynced);
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());
    unsub1();

    // 03. c2 changes the sync mode to manual sync mode again.
    await c2.pause(d2);
    d1.update((root) => {
      root.version = 'v3';
    });
    assert.notEqual(d1.toSortedJSON(), d2.toSortedJSON());
    await c1.sync();
    await c2.sync();
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

    await c1.deactivate();
    await c2.deactivate();
  });

  it('Can change sync mode in manual sync', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    const c2 = new yorkie.Client(testRPCAddr);
    const c3 = new yorkie.Client(testRPCAddr);
    await c1.activate();
    await c2.activate();
    await c3.activate();

    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ c1: number; c2: number }>(docKey);
    const d2 = new yorkie.Document<{ c1: number; c2: number }>(docKey);
    const d3 = new yorkie.Document<{ c1: number; c2: number }>(docKey);

    // 01. c1, c2, c3 attach to the same document in manual sync.
    await c1.attach(d1, { isRealtimeSync: false });
    await c2.attach(d2, { isRealtimeSync: false });
    await c3.attach(d3, { isRealtimeSync: false });

    // 02. c1, c2 sync with push-pull mode.
    d1.update((root) => {
      root.c1 = 0;
    });
    d2.update((root) => {
      root.c2 = 0;
    });

    await c1.sync();
    await c2.sync();
    await c1.sync();
    assert.equal(d1.toSortedJSON(), '{"c1":0,"c2":0}');
    assert.equal(d2.toSortedJSON(), '{"c1":0,"c2":0}');

    // 03. c1 and c2 sync with push-only mode. So, the changes of c1 and c2
    // are not reflected to each other.
    // But, c3 can get the changes of c1 and c2, because c3 sync with pull-pull mode.
    d1.update((root) => {
      root.c1 = 1;
    });
    d2.update((root) => {
      root.c2 = 1;
    });
    await c1.sync(d1, SyncMode.PushOnly);
    await c2.sync(d2, SyncMode.PushOnly);
    await c3.sync();
    assert.equal(d1.toSortedJSON(), '{"c1":1,"c2":0}');
    assert.equal(d2.toSortedJSON(), '{"c1":0,"c2":1}');
    assert.equal(d3.toSortedJSON(), '{"c1":1,"c2":1}');

    // 04. c1 and c2 sync with push-pull mode.
    await c1.sync();
    await c2.sync();
    assert.equal(d1.toSortedJSON(), '{"c1":1,"c2":1}');
    assert.equal(d2.toSortedJSON(), '{"c1":1,"c2":1}');

    await c1.deactivate();
    await c2.deactivate();
    await c3.deactivate();
  });

  it('Can change sync mode in realtime sync', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    const c2 = new yorkie.Client(testRPCAddr);
    const c3 = new yorkie.Client(testRPCAddr);
    await c1.activate();
    await c2.activate();
    await c3.activate();

    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ c1: number; c2: number }>(docKey);
    const d2 = new yorkie.Document<{ c1: number; c2: number }>(docKey);
    const d3 = new yorkie.Document<{ c1: number; c2: number }>(docKey);

    // 01. c1, c2, c3 attach to the same document in realtime sync.
    await c1.attach(d1);
    await c2.attach(d2);
    await c3.attach(d3);

    const d1Events: Array<string> = [];
    const d2Events: Array<string> = [];
    const d3Events: Array<string> = [];
    const stub1 = sinon.stub().callsFake((event) => {
      d1Events.push(event.type);
    });
    const stub2 = sinon.stub().callsFake((event) => {
      d2Events.push(event.type);
    });
    const stub3 = sinon.stub().callsFake((event) => {
      d3Events.push(event.type);
    });
    const unsub1 = d1.subscribe(stub1);
    const unsub2 = d2.subscribe(stub2);
    const unsub3 = d3.subscribe(stub3);

    // 02. c1, c2 sync in realtime.
    d1.update((root) => {
      root.c1 = 0;
    });
    d2.update((root) => {
      root.c2 = 0;
    });
    await waitStubCallCount(stub1, 2); // local-change, remote-change
    await waitStubCallCount(stub2, 2); // local-change, remote-change
    assert.equal(d1.toSortedJSON(), '{"c1":0,"c2":0}');
    assert.equal(d2.toSortedJSON(), '{"c1":0,"c2":0}');

    // 03. c1 and c2 sync with push-only mode. So, the changes of c1 and c2
    // are not reflected to each other.
    // But, c3 can get the changes of c1 and c2, because c3 sync with pull-pull mode.
    c1.pauseRemoteChanges(d1);
    c2.pauseRemoteChanges(d2);
    d1.update((root) => {
      root.c1 = 1;
    });
    d2.update((root) => {
      root.c2 = 1;
    });

    await waitStubCallCount(stub1, 3); // local-change
    await waitStubCallCount(stub2, 3); // local-change
    await waitStubCallCount(stub3, 3);
    assert.equal(d1.toSortedJSON(), '{"c1":1,"c2":0}');
    assert.equal(d2.toSortedJSON(), '{"c1":0,"c2":1}');
    assert.equal(d3.toSortedJSON(), '{"c1":1,"c2":1}');

    // 04. c1 and c2 sync with push-pull mode.
    c1.resumeRemoteChanges(d1);
    c2.resumeRemoteChanges(d2);
    await waitStubCallCount(stub1, 4);
    await waitStubCallCount(stub2, 4);
    assert.equal(d1.toSortedJSON(), '{"c1":1,"c2":1}');
    assert.equal(d2.toSortedJSON(), '{"c1":1,"c2":1}');

    unsub1();
    unsub2();
    unsub3();
    await c1.deactivate();
    await c2.deactivate();
    await c3.deactivate();
  });

  it('sync option with mixed mode test', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    await c1.activate();

    // 01. cli attach to the document having counter.
    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ counter: Counter }>(docKey);
    await c1.attach(d1, { isRealtimeSync: false });

    // 02. cli update the document with creating a counter
    //     and sync with push-pull mode: CP(1, 1) -> CP(2, 2)
    d1.update((root) => {
      root.counter = new yorkie.Counter(yorkie.IntType, 0);
    });

    let checkpoint = d1.getCheckpoint();
    assert.equal(checkpoint.getClientSeq(), 1);
    assert.equal(checkpoint.getServerSeq().toInt(), 1);

    await c1.sync();
    checkpoint = d1.getCheckpoint();
    assert.equal(checkpoint.getClientSeq(), 2);
    assert.equal(checkpoint.getServerSeq().toInt(), 2);

    // 03. cli update the document with increasing the counter(0 -> 1)
    //     and sync with push-only mode: CP(2, 2) -> CP(3, 2)
    d1.update((root) => {
      root.counter.increase(1);
    });
    let changePack = d1.createChangePack();
    assert.equal(changePack.getChangeSize(), 1);

    await c1.sync(d1, SyncMode.PushOnly);
    checkpoint = d1.getCheckpoint();
    assert.equal(checkpoint.getClientSeq(), 3);
    assert.equal(checkpoint.getServerSeq().toInt(), 2);

    // 04. cli update the document with increasing the counter(1 -> 2)
    //     and sync with push-pull mode. CP(3, 2) -> CP(4, 4)
    d1.update((root) => {
      root.counter.increase(1);
    });

    // The previous increase(0 -> 1) is already pushed to the server,
    // so the ChangePack of the request only has the increase(1 -> 2).
    changePack = d1.createChangePack();
    assert.equal(changePack.getChangeSize(), 1);

    await c1.sync();
    checkpoint = d1.getCheckpoint();
    assert.equal(checkpoint.getClientSeq(), 4);
    assert.equal(checkpoint.getServerSeq().toInt(), 4);
    assert.equal(d1.getRoot().counter.getValue(), 2);

    await c1.deactivate();
  });
});
