import unittest
from backend.explorer_dimensions import dimension_names, dimension_values, pack_scores, catalog_sql, monitor_module


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


if __name__ == '__main__':
    unittest.main()
