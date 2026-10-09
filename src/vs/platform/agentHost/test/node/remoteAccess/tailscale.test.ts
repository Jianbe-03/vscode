/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findTailscaleLink, parseFunnelStatus, parseTailscaleStatus } from '../../../node/remoteAccess/tailscale.js';

suite('Remote Access Tailscale', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses the status', () => {
		const status = parseTailscaleStatus(JSON.stringify({
			BackendState: 'Running',
			Self: { DNSName: 'my-mac.tailnet.ts.net.', TailscaleIPs: ['fd7a:115c:a1e0::1', '100.64.0.1'] },
		}));
		assert.deepStrictEqual(status, { backendState: 'Running', running: true, ipv4: '100.64.0.1', dnsName: 'my-mac.tailnet.ts.net' });
	});

	test('finds the Funnel URL of a port', () => {
		const config = JSON.stringify({
			TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } },
			Web: {
				'my-mac.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } },
				'my-mac.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
			},
			AllowFunnel: { 'my-mac.tailnet.ts.net:443': true, 'my-mac.tailnet.ts.net:8443': true },
		});
		const serveOnly = JSON.stringify({ Web: { 'my-mac.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } } } });
		assert.deepStrictEqual(
			[parseFunnelStatus(config, 8790), parseFunnelStatus(config, 3000), parseFunnelStatus(config, 1234), parseFunnelStatus(serveOnly, 8790), parseFunnelStatus('', 8790)],
			['https://my-mac.tailnet.ts.net', 'https://my-mac.tailnet.ts.net:8443', undefined, undefined, undefined],
		);
	});

	test('finds the link to allow Funnel', () => {
		assert.strictEqual(findTailscaleLink('Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=abc\n'), 'https://login.tailscale.com/f/funnel?node=abc');
	});
});
