"""Diagnostics must not expose credentials, call POI services or mutate collection."""
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase,main
from unittest.mock import MagicMock,patch
from pydantic import SecretStr
from backend import poi_diagnostics as doctor
from backend.settings import Settings
from backend.poi_provider import Neshan,access_error_message

class DiagnosticTests(TestCase):
    def settings(self,key='effective-secret'):
        return Settings(_env_file=None,database_url='postgresql+psycopg://test:db-secret@127.0.0.1/db',
            captcha_enabled=False,neshan_service_api_key=SecretStr(key),neshan_collection_authorized=True)

    def test_environment_shadowing_detected_without_exposing_any_key(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/'.env';path.write_text('NESHAN_SERVICE_API_KEY=file-secret\n',encoding='utf-8')
            report=doctor.configuration_report(self.settings(),path,{'NESHAN_SERVICE_API_KEY':'effective-secret'})
        output=json.dumps(report)
        self.assertEqual(report['effective_key_source'],'environment')
        self.assertFalse(report['effective_key_matches_env_file'])
        self.assertNotIn('effective-secret',output);self.assertNotIn('file-secret',output)
        self.assertTrue(any('overrides' in s for s in report['configuration_findings']))

    def test_duplicate_file_keys_and_accidental_map_key_reuse_are_visible(self):
        settings=self.settings('file-secret');settings.neshan_map_api_key=SecretStr('file-secret')
        with TemporaryDirectory() as directory:
            path=Path(directory)/'.env';path.write_text('NESHAN_SERVICE_API_KEY=old-secret\nNESHAN_SERVICE_API_KEY=file-secret\n',encoding='utf-8')
            report=doctor.configuration_report(settings,path,{})
        self.assertEqual(report['service_key_definitions_in_env_file'],2)
        self.assertTrue(report['service_key_equals_browser_map_key'])
        self.assertTrue(report['effective_key_matches_env_file'])
        self.assertNotIn('file-secret',json.dumps(report))

    def test_read_only_database_report_queries_metadata_only(self):
        engine=MagicMock();connection=engine.connect.return_value.__enter__.return_value
        results=[MagicMock() for _ in range(6)]
        results[1].scalars.return_value.all.return_value=['0016_poi_nonretention']
        results[2].scalars.return_value.__iter__.return_value=iter(['poi_requests','poi_control'])
        results[3].mappings.return_value.all.return_value=[{'id':7,'kind':'details','http_status':484,'outcome':'failed'}]
        results[4].mappings.return_value.first.return_value={'id':7,'kind':'details','http_status':484}
        results[5].mappings.return_value.first.return_value={'paused':True,'in_flight':None,'heartbeat_at':None,'worker_id':'host:uuid:k123456abcdef'}
        connection.execute.side_effect=results
        with patch.object(doctor,'create_engine',return_value=engine): report=doctor.database_report(self.settings())
        sql=[str(call.args[0]) for call in connection.execute.call_args_list]
        self.assertEqual(sql[0],'SET TRANSACTION READ ONLY')
        self.assertTrue(all(statement.startswith(('SELECT','SET TRANSACTION READ ONLY')) for statement in sql))
        self.assertTrue(all('raw_response' not in s and 'provider_id' not in s for s in sql))
        self.assertEqual(report['latest_http_484']['kind'],'details')
        self.assertEqual(report['control']['worker_key_fingerprint'],'123456abcdef')
        engine.dispose.assert_called_once()

    def test_database_error_text_cannot_leak_password(self):
        engine=MagicMock();engine.connect.side_effect=RuntimeError('db-secret should never be printed')
        with patch.object(doctor,'create_engine',return_value=engine): report=doctor.database_report(self.settings())
        self.assertEqual(report['status'],'unavailable')
        self.assertNotIn('db-secret',json.dumps(report))

    def test_ip_probe_has_no_provider_authentication_header(self):
        opener=MagicMock();opener.open.return_value.__enter__.return_value.read.return_value=b'{"ip":"203.0.113.9"}'
        with patch.object(doctor,'build_opener',return_value=opener): report=doctor.egress_report()
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,'https://api.ipify.org?format=json')
        self.assertIsNone(request.get_header('Api-key'))
        self.assertEqual(report['observed_public_ipv4'],'203.0.113.9')

    def test_report_does_not_probe_any_network_by_default(self):
        with TemporaryDirectory() as directory,patch.object(doctor,'database_report',return_value={'status':'ok'}),patch.object(doctor,'egress_report') as probe:
            report=doctor.collect_report(self.settings(),Path(directory)/'.env')
        probe.assert_not_called()
        self.assertEqual(report['provider_calls_made'],0)
        self.assertFalse(report['provider_access_verified'])

    def test_wrong_running_worker_key_is_detected(self):
        with TemporaryDirectory() as directory,patch.object(doctor,'database_report',return_value={
            'status':'ok','control':{'worker_key_fingerprint':doctor.fingerprint('old-secret')}}):
            report=doctor.collect_report(self.settings(),Path(directory)/'.env')
        self.assertFalse(report['worker_uses_current_key'])

    def test_access_errors_identify_service_and_not_confuse_whitelist_with_quota(self):
        provider=Neshan('never-print-this-key')
        self.assertEqual(len(provider.key_fingerprint),12)
        message=access_error_message('details',484)
        self.assertIn('POI Details (/v1/point)',message)
        self.assertIn('ApiWhiteListError',message)
        self.assertNotIn('quota',message)
        self.assertNotIn('never-print-this-key',message)
        self.assertIn('Nearby (/v1/nearby)',access_error_message('nearby',484))

if __name__=='__main__': main()
