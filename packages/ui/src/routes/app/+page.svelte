<script lang="typescript">
	import * as syncit from '$lib/index';
	import * as syncitTransporter from '@syncit/transporter';

	new syncit.App({
		target: document.body,
		props: {
			lang: 'zh-CN',
			bufferMs: 100,
			createTransporter({ role, uid }) {
				// return new syncitTransporter.LocalStorageTransporter();
				return new syncitTransporter.WebSocketTransporter({url:`ws://localhost:3000/?role=${role}&uid=${uid}`});
			}
		}
	});
</script>