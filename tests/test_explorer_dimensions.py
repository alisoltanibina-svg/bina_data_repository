import unittest
from backend.explorer_dimensions import dimension_names, dimension_values, pack_scores, catalog_sql, monitor_module, resolve_module_mapping


class ExplorerDimensionsTest(unittest.TestCase):
    def test_import_formats_and_arbitrary_dimension_count(self):
        self.assertEqual(dimension_values('{province: 2, sex:1, residence: 2, age: 5}'),
                         {'province': '2', 'sex': '1', 'residence': '2', 'age': '5'})
        self.assertEqual(dimension_values({'sex': 1}), {'sex': '1'})
        self.assertEqual(dimension_values('{"province":15}'), {'province': '15'})
        self.assertEqual(dimension_names('{province, sex, residence, age}'), ['province', 'sex', 'residence', 'age'])
        self.assertEqual(dimension_names(['sex', 'sex']), ['sex'])
        with self.assertRaises(ValueError):
            dimension_values('{sex:1,sex:2}')

    def test_breakdowns_stay_distinct_and_labels_are_resolved(self):
        rows = [{'province_name': None, 'year': 1400, 'value': value,
                 'dim_cat_values': {'province': 2, 'sex': sex}} for value, sex in [(12, 1), (24, 2)]]
        lookup = [{'dimension_name': n, 'dimension_value': v, 'dimension_key': label}
                  for n, v, label in [('province', 2, 'Tehran'), ('sex', 1, 'Male'), ('sex', 2, 'Female')]]
        scores, filters = pack_scores(rows, '{province,sex}', lookup)
        self.assertNotEqual(scores[0]['series_id'], scores[1]['series_id'])
        self.assertEqual(scores[0]['province_name'], 'Tehran')
        self.assertIn('Male', scores[0]['series_label'])
        self.assertEqual([f['name'] for f in filters], ['province', 'sex'])
        self.assertEqual(len(filters[1]['values']), 2)
        with self.assertRaises(ValueError):
            pack_scores(rows + [rows[0]], '{province,sex}', lookup)

    def test_only_declared_filters_and_legacy_rows(self):
        scores, filters = pack_scores([{'year': 1, 'dim_cat_values': '{sex:1,residence:2}'}], '{sex}', [])
        self.assertEqual([f['name'] for f in filters], ['sex'])
        self.assertIn('residence: 2', scores[0]['series_label'])
        scores, filters = pack_scores([{'year': 1, 'province_name': 'Tehran'}], None, [])
        self.assertEqual(scores[0]['series_label'], 'Tehran')
        self.assertEqual(filters[0]['name'], 'province')

    def test_blank_monitor_mappings_use_defaults_without_mutating_source(self):
        for blank in (None, '', '   '):
            module = dict(module_name='Monitor Indicators', **dict.fromkeys(
                ('ref_table', 'topic', 'subtopic', 'indicator', 'filter'), blank))
            resolved = resolve_module_mapping(module)
            self.assertEqual(resolved['ref_table'], 'kdescription')
            self.assertEqual(resolved['filter'], 'dimensions')
            self.assertEqual(module['ref_table'], blank)
            sql = catalog_sql(module, ['topic_name', 'subtopic_name', 'indicator_name', 'dimensions'])
            self.assertIn('"dimensions" AS "filter"', sql)
            self.assertIn('"topic_name" AS "topic"', sql)

    def test_imported_mixed_case_reference_uses_lowercase_table(self):
        for ref in ('Kdescription', 'KDESCRIPTION', 'Analytics.Kdescription', ' Analytics . Kdescription '):
            with self.subTest(ref=ref):
                module = {'module_name': 'Monitor Indicators', 'ref_table': ref}
                resolved = resolve_module_mapping(module)
                self.assertIn(resolved['ref_table'], ('kdescription', 'analytics.kdescription'))
                sql = catalog_sql(module, ['topic_name', 'subtopic_name', 'indicator_name', 'dimensions'])
                self.assertIn('FROM "analytics"."kdescription"', sql)
                self.assertEqual(module['ref_table'], ref)
        for ref in ('Accounts.Users', 'analytics.kdescription; DROP TABLE users'):
            with self.assertRaises(ValueError):
                catalog_sql({'ref_table': ref}, [])

    def test_optional_custom_mappings_produce_null_fields(self):
        for role in ('topic', 'subtopic', 'indicator', 'filter'):
            for blank in (None, '', '  '):
                module = dict(ref_table='custom_catalog', topic='domain', subtopic='subject', indicator='name', filter='dims')
                module[role] = blank
                sql = catalog_sql(module, ['domain', 'subject', 'name', 'dims'])
                self.assertIn(f'NULL AS "{role}"', sql)
        self.assertIn('WHERE FALSE', catalog_sql({'module_name': 'Future Module'}, []))

    def test_catalog_identifiers_are_checked(self):
        module = dict(ref_table='kdescription', topic='domain', subtopic='subject', indicator='name', filter='dims')
        columns = ['domain', 'subject', 'name', 'dims']
        self.assertIn('SELECT DISTINCT', catalog_sql(module, columns))
        self.assertIn('"domain" AS "topic"', catalog_sql(module, columns))
        for ref in ['accounts.users', 'kdescription; DROP TABLE users', 'a.b.c']:
            with self.assertRaises(ValueError):
                catalog_sql({**module, 'ref_table': ref}, columns)
        with self.assertRaises(ValueError):
            catalog_sql({**module, 'filter': 'secret'}, columns)
        self.assertTrue(monitor_module({'module_name': 'نماگرهای دیده بان'}))
        self.assertFalse(monitor_module({'module_name': 'Other'}))


class ExplorerStartupTest(unittest.TestCase):
    def namespace(self):
        # Execute only the relevant functions; never import an app or read DB settings.
        import ast
        import json
        from contextlib import nullcontext
        from pathlib import Path
        from unittest.mock import Mock
        from fastapi import HTTPException
        selected = {'_warm_cache', '_compute_explorer_init', '_compute_explorer_indicator', 'get_explorer_init'}
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'backend/main.py').read_text(encoding='utf-8'))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in selected]
        for node in functions:
            node.decorator_list = []
        class Cache:
            def __init__(self): self.values = {}
            def get(self, key, factory, **kwargs):
                if key not in self.values: self.values[key] = factory()
                return self.values[key]
        cache = Cache()
        ns = dict(HTTPException=HTTPException, catalog_sql=catalog_sql, monitor_module=monitor_module, resolve_module_mapping=resolve_module_mapping,
                  pack_scores=pack_scores, db_connection=lambda: nullcontext(object()),
                  get_cache=lambda: cache, _json_bytes=lambda value: json.dumps(value).encode(),
                  Request=object, log=Mock(), _require_user=lambda request: None)
        for name in ('topics_min', 'trend_provinces', 'indicator_names', 'subtopic_names', 'atlas', 'race_indicator_names'):
            ns['_compute_' + name] = lambda: []
        ns['fetchall_dicts'] = Mock(return_value=[])
        def cached_json(key, factory, *args, **kwargs):
            return cache.get(key, lambda: ns['_json_bytes'](factory()))
        ns['_cached_json'] = cached_json
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<explorer-startup>', 'exec'), ns)
        return ns, cache

    def test_invalid_mapping_does_not_stop_startup_and_is_retried(self):
        from unittest.mock import Mock
        ns, cache = self.namespace()
        ns['_compute_explorer_init'] = Mock(side_effect=ns['HTTPException'](503, 'Invalid module column: filter'))
        ns['_warm_cache']()
        ns['log'].warning.assert_called_once()
        self.assertNotIn('explorer-catalog-v2', cache.values)
        self.assertIn('race-indicators', cache.values)
        with self.assertRaises(ns['HTTPException']):
            ns['get_explorer_init'](object())
        self.assertEqual(ns['_compute_explorer_init'].call_count, 2)

    def test_unexpected_startup_failure_is_not_hidden(self):
        from unittest.mock import Mock
        ns, _ = self.namespace()
        ns['_compute_explorer_init'] = Mock(side_effect=RuntimeError('Database unavailable'))
        with self.assertRaises(RuntimeError): ns['_warm_cache']()

    def test_missing_mapping_names_the_field(self):
        from unittest.mock import Mock
        ns, _ = self.namespace()
        module = dict(module_name='Monitor Indicators', ref_table='kdescription',
                      topic='topic_name', subtopic='subtopic_name', indicator='indicator_name', filter='nonexistent_column')
        ns['fetchall_dicts'] = Mock(side_effect=[[], [{'data': module}],
            [{'column_name': c} for c in ('topic_name', 'subtopic_name', 'indicator_name', 'dimensions')]])
        with self.assertRaises(ns['HTTPException']) as error: ns['_compute_explorer_init']()
        self.assertIn('filter', error.exception.detail)
        self.assertIn('Monitor Indicators', error.exception.detail)

    def test_monitor_with_all_empty_mappings_builds_catalog(self):
        from unittest.mock import Mock
        ns, _ = self.namespace()
        source = dict(module_name='Monitor Indicators', ref_table=None, topic='', subtopic=None, indicator=' ', filter=None)
        ns['fetchall_dicts'] = Mock(side_effect=[[], [{'data': source}],
            [{'column_name': c} for c in ('topic_name', 'subtopic_name', 'indicator_name', 'dimensions')],
            [{'topic': 'Domain', 'subtopic': 'Subject', 'indicator': 'Example', 'filter': '{sex}'}]])
        result = ns['_compute_explorer_init']()
        self.assertEqual(result['hierarchy'], {'Domain': {'Subject': ['Example']}})
        self.assertEqual(result['modules'][0]['indicator_dimensions']['Example'], '{sex}')
        self.assertIsNone(source['ref_table'])

    def test_reported_imported_module_rows_resolve_catalog(self):
        from unittest.mock import Mock
        ns, _ = self.namespace()
        source = dict(module_name='نماگرهای دیده‌بان', ref_table='Kdescription', topic='topic_name',
                      subtopic='subtopic_name', indicator='indicator_name', filter='dimensions')
        other_modules = [{'data': {'module_name': name, 'ref_table': ref}}
                         for name, ref in [('Statistics', 'Sudescription'), ('Places', 'poi'), ('Actors', 'actors')]]
        def fetch(conn, sql, params=None):
            if 'analytics.topics' in sql: return []
            if 'analytics.modules' in sql: return [{'data': source}] + other_modules
            if 'information_schema.columns' in sql:
                self.assertEqual(params, {'table': 'kdescription'})
                return [{'column_name': c} for c in ('topic_name', 'subtopic_name', 'indicator_name', 'dimensions')]
            self.assertIn('FROM "analytics"."kdescription"', sql)
            return [{'topic': 'Domain', 'subtopic': 'Subject', 'indicator': 'Example', 'filter': '{province}'}]
        ns['fetchall_dicts'] = Mock(side_effect=fetch)
        response = ns['get_explorer_init'](object())
        import json
        result = json.loads(response)
        self.assertEqual(len(result['modules']), 4)
        self.assertEqual(result['hierarchy'], {'Domain': {'Subject': ['Example']}})
        self.assertEqual([m['active'] for m in result['modules']], [True, False, False, False])
        self.assertEqual(source['ref_table'], 'Kdescription')
        self.assertEqual(ns['fetchall_dicts'].call_count, 4)

    def test_custom_empty_mappings_and_inactive_module_do_not_fail(self):
        from unittest.mock import Mock
        ns, _ = self.namespace()
        ns['fetchall_dicts'] = Mock(side_effect=[[], [{'data': {'module_name': 'Monitor Indicators', 'ref_table': 'custom_catalog'}},
            {'data': {'module_name': 'Future Module', 'ref_table': None}}], [],
            [{'topic': None, 'subtopic': None, 'indicator': None, 'filter': None}]])
        result = ns['_compute_explorer_init']()
        self.assertEqual(len(result['modules']), 2)
        self.assertEqual(result['hierarchy'], {})

    def test_response_bytes_and_catalog_objects_have_separate_keys(self):
        from unittest.mock import Mock
        ns, cache = self.namespace()
        catalog = {'modules': [{'active': True, 'indicator_dimensions': {'Example': '{sex}'}}]}
        ns['_compute_explorer_init'] = lambda: catalog
        self.assertIsInstance(ns['get_explorer_init'](object()), bytes)
        ns['fetchone_dict'] = Mock(return_value={'dimensions': '{sex}'})
        ns['fetchall_dicts'] = Mock(side_effect=[
            [{'year': 1400, 'value': 10, 'dim_cat_values': {'sex': 1}}], []])
        result = ns['_compute_explorer_indicator']('Example')
        self.assertEqual(result['filters'][0]['name'], 'sex')
        self.assertIsInstance(cache.values['explorer-init-v2'], bytes)
        self.assertIsInstance(cache.values['explorer-catalog-v2'], dict)


if __name__ == '__main__':
    unittest.main()
