"""Location module contracts. Synthetic fixtures only; no DB or Neshan calls."""
import os
os.environ.setdefault('DATABASE_URL', 'postgresql+psycopg://test:test@localhost/test')
os.environ.setdefault('CAPTCHA_ENABLED', '0')

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import SecretStr
from backend import poi_explore as explore
from backend import poi_budget as budget
from backend.poi_provider import Reply


class ExploreTest(unittest.TestCase):
    def setUp(self):
        self.category = SimpleNamespace(category='mosque', title='مسجد',
            icon_url='https://static.neshanmap.ir/poi/64/mosque.png', is_published=True, sort_order=0)
        self.settings = SimpleNamespace(neshan_explore_authorized=True,
            neshan_service_api_key=SecretStr('synthetic-key'), neshan_nearby_result_cap=0, neshan_explore_interval_seconds=1.0)
        self.session = Mock()
        self.session.get.return_value = self.category
        self.session.scalars.return_value.all.return_value = [self.category]
        @contextmanager
        def session(): yield self.session
        self.db_patch = patch.object(explore.database, 'db_session', session)
        self.db_patch.start(); self.addCleanup(self.db_patch.stop)
        self.settings_patch = patch.object(explore, 'get_settings', return_value=self.settings)
        self.settings_patch.start(); self.addCleanup(self.settings_patch.stop)

    def client(self, signed_in=True, admin=False):
        def user(request):
            if not signed_in: raise HTTPException(401)
        def require_admin(request):
            if not admin: raise HTTPException(403)
        app = FastAPI(); app.include_router(explore.build_router(require_admin, user))
        return TestClient(app)

    def test_init_returns_published_categories_and_no_store(self):
        response = self.client().get('/api/poi-explore/init')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['categories'][0]['category'], 'mosque')
        self.assertEqual(response.json()['live']['min_zoom'], 8)
        self.assertIn('no-store', response.headers['cache-control'])
        sql = str(self.session.scalars.call_args.args[0])
        self.assertIn('is_published IS true', sql)

    def test_auth_and_expanded_permission_checked_before_database_or_provider(self):
        with patch.object(explore, 'reserve_live_request') as reserve, patch.object(explore, 'Neshan') as provider:
            self.assertEqual(self.client(False).get('/api/poi-explore/init').status_code, 401)
            self.settings.neshan_explore_authorized = False
            self.assertEqual(self.client().get('/api/poi-explore/init').status_code, 503)
            response = self.client().post('/api/poi-explore/nearby', json=dict(category='mosque', latitude=35, longitude=51, zoom=13))
            self.assertEqual(response.status_code, 503)
            reserve.assert_not_called(); provider.assert_not_called(); self.session.get.assert_not_called()

    def test_only_admin_can_change_publication(self):
        client = self.client()
        self.assertEqual(client.get('/api/admin/poi/explore-categories').status_code, 403)
        self.assertEqual(client.patch('/api/admin/poi/explore-categories/mosque', json={'is_published':False}).status_code, 403)
        self.assertTrue(self.category.is_published)
        response = self.client(admin=True).patch('/api/admin/poi/explore-categories/mosque', json={'is_published':False})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.category.is_published)

    def test_unknown_and_unpublished_categories_never_reach_provider(self):
        with patch.object(explore, 'Neshan') as provider, patch.object(explore, 'reserve_live_request') as reserve:
            client = self.client()
            for category in ('unsupported', 'mosque'):
                self.category.is_published = False
                response = client.post('/api/poi-explore/nearby', json=dict(category=category, latitude=35, longitude=51, zoom=13))
                self.assertEqual(response.status_code, 404)
            provider.assert_not_called(); reserve.assert_not_called()

    def test_invalid_zoom_and_coordinates_are_rejected_before_provider(self):
        with patch.object(explore, 'Neshan') as provider:
            for change in ({'zoom':7},{'zoom':'13'},{'latitude':80},{'longitude':20}):
                data = dict(category='mosque', latitude=35, longitude=51, zoom=13); data.update(change)
                self.assertEqual(self.client().post('/api/poi-explore/nearby', json=data).status_code, 422)
            provider.assert_not_called()

    def test_nearby_is_sanitized_bounded_and_not_written_or_cached(self):
        item = dict(name='Synthetic mosque',location=dict(latitude=35.5,longitude=51.5),poiHash='must-not-be-retained',phone='private')
        with patch.object(explore, 'reserve_live_request') as reserve, patch.object(explore, 'Neshan') as provider, patch.object(explore.database, 'get_cache') as cache:
            provider.return_value.request.return_value = Reply(200, {'layerPoints':{'nearestPoints':[item,item]}})
            response = self.client().post('/api/poi-explore/nearby', json=dict(category='mosque',latitude=35.5,longitude=51.5,zoom=15))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['radius_m'], 1000)
            self.assertEqual(response.json()['places'], [dict(name='Synthetic mosque', latitude=35.5, longitude=51.5)])
            self.assertNotIn('must-not-be-retained', response.text)
            self.assertNotIn('phone', response.text)
            self.assertIn('no-store', response.headers['cache-control'])
            self.assertEqual(response.headers['x-accel-buffering'],'no')
            reserve.assert_called_once()
            cache.assert_not_called(); self.session.execute.assert_not_called(); self.session.add.assert_not_called()
            self.assertEqual(provider.return_value.request.call_args.kwargs, {'timeout':5,'max_bytes':1048576})
            self.assertEqual(provider.return_value.request.call_args.args, ('nearby', {'location':'35.5,51.5', 'layer':'mosque', 'searchRadius':1000}))

    def test_regional_view_searches_a_100_km_radius(self):
        with patch.object(explore, 'reserve_live_request'), patch.object(explore, 'Neshan') as provider:
            provider.return_value.request.return_value = Reply(200, {'layerPoints': {'nearestPoints': []}})
            response = self.client().post('/api/poi-explore/nearby', json=dict(
                category='mosque', latitude=35, longitude=51, zoom=8))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['radius_m'], 100000)
            self.assertEqual(provider.return_value.request.call_args.args[1]['searchRadius'], 100000)
        self.assertEqual(set(explore.LIVE_RADII), set(range(8, 20)))
        radii = list(explore.LIVE_RADII.values())
        self.assertEqual(radii, sorted(radii, reverse=True))

    def test_viewport_radius_is_forwarded_and_bounded(self):
        with patch.object(explore, 'reserve_live_request'), patch.object(explore, 'Neshan') as provider:
            provider.return_value.request.return_value = Reply(200, {'layerPoints': {'nearestPoints': []}})
            data = dict(category='mosque', latitude=35, longitude=51, zoom=15, radius_m=28000)
            response = self.client().post('/api/poi-explore/nearby', json=data)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['radius_m'], 28000)
            self.assertEqual(provider.return_value.request.call_args.args[1]['searchRadius'], 28000)
            for radius in (100001, 0, '28000'):
                self.assertEqual(self.client().post('/api/poi-explore/nearby', json={**data, 'radius_m': radius}).status_code, 422)

    def test_documented_travel_distance_does_not_exclude_nearby_points(self):
        # PDF page 5: route distance may exceed the straight-line search radius.
        points, count=explore.nearby_display_points({'layerPoints':{'nearestPoints':[
            dict(name='Nearby park', location=dict(latitude=35.0001,longitude=51.0001), distance=3281, duration=535)]}})
        self.assertEqual(count,1)
        self.assertEqual(points,[dict(name='Nearby park',latitude=35.0001,longitude=51.0001)])

    def test_provider_limit_sets_backoff_and_does_not_retry(self):
        with patch.object(explore, 'reserve_live_request'), patch.object(explore, 'extend_provider_backoff') as backoff, patch.object(explore, 'Neshan') as provider:
            provider.return_value.request.return_value=Reply(482,retry_after=120)
            response=self.client().post('/api/poi-explore/nearby',json=dict(category='mosque',latitude=35,longitude=51,zoom=13))
            self.assertEqual(response.status_code,429)
            self.assertEqual(response.headers['retry-after'],'120')
            backoff.assert_called_once_with(120); provider.return_value.request.assert_called_once()

    def test_invalid_provider_schema_is_safe_error(self):
        with patch.object(explore, 'reserve_live_request'), patch.object(explore, 'Neshan') as provider:
            provider.return_value.request.return_value=Reply(200,{'secret':'not-for-client'})
            response=self.client().post('/api/poi-explore/nearby',json=dict(category='mosque',latitude=35,longitude=51,zoom=13))
            self.assertEqual(response.status_code,502)
            self.assertNotIn('not-for-client',response.text)

    def test_counts_use_numeric_aggregate_cache_and_preserve_unknowns(self):
        provinces=[dict(province='تهران',latitude=35.5,longitude=51.5),dict(province='گیلان',latitude=37,longitude=49)]
        aggregate=explore.aggregate_provinces(provinces,[('تهران',3),(None,2)])
        cache=Mock();cache.get.return_value=aggregate
        with patch.object(explore, 'province_catalog', return_value=provinces),patch.object(explore.database,'get_cache',return_value=cache):
            response=self.client().get('/api/poi-explore/counts?category=mosque')
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json()['provinces'][0]['count'],3)
            self.assertIsNone(response.json()['provinces'][1]['count'])
            self.assertEqual(response.json()['unassigned_count'],2)
            self.assertFalse(response.json()['completeness_verified'])
            self.assertEqual(cache.get.call_args.kwargs,{'ttl_seconds':60})

    def test_count_query_joins_categories_and_places(self):
        self.session.execute.return_value.all.return_value=[('تهران',2)]
        result=explore.stored_counts('mosque',[dict(province='تهران')])
        self.assertEqual(result['provinces'][0]['count'],2)
        query=self.session.execute.call_args.args[0]
        self.assertIn('JOIN poi.poi_place_categories',str(query))
        self.assertIn('GROUP BY poi.poi_places.province_name',str(query))
        self.assertEqual(query.compile().params['category_1'],'mosque')

    def test_live_budget_uses_short_metadata_slot_without_collector_cooldown(self):
        rows=[SimpleNamespace(key=budget.LIVE_NEXT_KEY,value='0'),SimpleNamespace(key=budget.BACKOFF_KEY,value='0')]
        self.session.scalars.return_value.all.return_value=rows
        explore.reserve_live_request()
        remaining=float(rows[0].value)-datetime.now(timezone.utc).timestamp()
        self.assertGreater(remaining,0)
        self.assertLessEqual(remaining,1)
        with self.assertRaises(HTTPException) as caught: explore.reserve_live_request()
        self.assertEqual(caught.exception.status_code,429)
        self.assertEqual(caught.exception.headers['Retry-After'],'1')
        self.session.get.assert_not_called()
        for call in self.session.execute.call_args_list:
            self.assertNotIn('poi_control',str(call.args[0]))

    def test_actual_provider_backoff_overrides_fast_live_slot(self):
        rows=[SimpleNamespace(key=budget.LIVE_NEXT_KEY,value='0'),SimpleNamespace(key=budget.BACKOFF_KEY,value='175')]
        self.session.scalars.return_value.all.return_value=rows
        with self.assertRaises(budget.ProviderBusy) as caught:
            budget.reserve_live_slot(self.session,1,stamp=100)
        self.assertEqual(caught.exception.seconds,75)
        self.assertEqual(rows[0].value,'0')
        self.session.get.return_value=rows[1]
        self.assertEqual(budget.provider_backoff_until(self.session),175)
        budget.record_provider_backoff(self.session,120,stamp=100)
        statement=self.session.execute.call_args.args[0]
        self.assertIn('greatest',str(statement))
        self.assertEqual(statement.compile().params['value'],'220')

    def test_init_publishes_fast_config_and_configured_account_interval(self):
        payload=self.client().get('/api/poi-explore/init').json()
        self.assertEqual(payload['live']['debounce_ms'],200)
        self.assertEqual(payload['live']['interval_ms'],1000)
        self.settings.neshan_explore_interval_seconds=3
        payload=self.client().get('/api/poi-explore/init').json()
        self.assertEqual(payload['live']['interval_ms'],3000)

    def test_collector_rate_error_shares_actual_backoff_with_live_search(self):
        from backend import poi
        control=SimpleNamespace()
        request=SimpleNamespace(job_id=1,kind='nearby',target_type='segment',target_id=2)
        job=SimpleNamespace()
        target=SimpleNamespace(attempts=1)
        self.session.get.side_effect=[request,job,target]
        with patch.object(poi,'control',return_value=control),patch.object(poi.coverage,'plan_for',return_value=None),patch.object(poi,'record_provider_backoff') as shared:
            poi.apply_reply(self.session,1,Reply(482,retry_after=180))
            shared.assert_called_once_with(self.session,180)
        self.assertGreater(control.next_request_at,datetime.now(timezone.utc))

    def test_province_anchors_are_inside_the_supplied_boundaries(self):
        import json
        from pathlib import Path
        from shapely.geometry import shape, Point
        path=Path(__file__).resolve().parents[1] / 'data' / 'iran.geojson'
        anchors=explore.province_catalog(str(path),path.stat().st_mtime_ns)
        self.assertEqual(len(anchors),31)
        shapes={feature['properties']['ProvincNam']:shape(feature['geometry'])
                for feature in json.loads(path.read_text(encoding='utf-8-sig'))['features']}
        for anchor in anchors:
            self.assertTrue(shapes[anchor['province']].covers(Point(anchor['longitude'],anchor['latitude'])))

    def test_payload_parser_ignores_bad_points_and_bounds_render_count(self):
        valid=dict(name='A',location=dict(latitude=35,longitude=51))
        places,_=explore.nearby_display_points({'layerPoints':{'nearestPoints':[valid,valid,{'name':'bad','location':{'latitude':float('nan'),'longitude':51}}]}})
        self.assertEqual(len(places),1)
        points=[dict(name=str(i),location=dict(latitude=35,longitude=51)) for i in range(600)]
        places,count=explore.nearby_display_points({'layerPoints':{'nearestPoints':points}})
        self.assertEqual(len(places),500);self.assertEqual(count,600)
        self.category.icon_url='https://untrusted.example/icon.png'
        self.assertEqual(explore.category_dict(self.category)['icon_url'],'https://static.neshanmap.ir/poi/64/mosque.png')


if __name__ == '__main__': unittest.main()
