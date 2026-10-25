import unittest,math
from shapely.geometry import box,Point,Polygon,MultiPolygon
from shapely import union_all,set_precision
from backend.poi_coverage import cover,lattice,Circle,PRECISION_M,project,wgs84

class PolygonCoverageTests(unittest.TestCase):
    def assert_covered(self,target,circles,owned,certificate):
        self.assertTrue(certificate['verified'])
        self.assertEqual(certificate['uncovered_area_m2'],0)
        snapped=set_precision(target,PRECISION_M)
        self.assertTrue(snapped.difference(union_all([c.footprint() for c in circles])).is_empty)
        self.assertTrue(snapped.difference(union_all(owned)).is_empty)
    def test_holes_islands_edges_and_outside_centers(self):
        target=MultiPolygon([Polygon([(0,0),(3000,0),(3000,3000),(0,3000)],holes=[[(500,500),(1500,500),(1500,1500),(500,1500)]]),box(5010,1010,5011,1011)])
        circles,owned,cert=cover(target,500)
        self.assert_covered(target,circles,owned,cert)
        self.assertTrue(any(not target.covers(Point(c.x,c.y)) for c in circles))
    def test_adjacent_polygon_union_has_no_duplicate_centers(self):
        target=union_all([box(0,0,1000,2000),box(1000,0,2000,2000)])
        circles,owned,cert=cover(target,500)
        self.assert_covered(target,circles,owned,cert)
        self.assertEqual(len(circles),len({c.key for c in circles}))
        unoptimized=cover(target,500,optimize=False)[0]
        self.assertLessEqual(len(circles),len(unoptimized))
    def test_fixed_3km_point_can_cover_polygon_without_extra_queries(self):
        target=box(-500,-500,500,500);fixed=Circle('village',0,0,3000,True)
        circles,owned,cert=cover(target,500,[fixed])
        self.assertEqual([c.key for c in circles],['village'])
        self.assert_covered(target,circles,owned,cert)
    def test_2km_polygon_cover_preserves_3km_point_searches(self):
        target=union_all([box(-7000,-6000,9000,8000),box(9000,-6000,14000,8000)])
        fixed=Circle('village',0,0,3000,True)
        circles,owned,cert=cover(target,2000,[fixed])
        self.assert_covered(target,circles,owned,cert)
        self.assertEqual(next(c.radius_m for c in circles if c.key=='village'),3000)
        self.assertTrue(all(c.radius_m==2000 for c in circles if not c.fixed))
        smaller=cover(target,500,[fixed])[0]
        self.assertLess(len(circles),len(smaller))
    def test_triangular_lattice_spacing(self):
        circles=list(lattice(box(-3000,-3000,3000,3000),500));ys=sorted({c.y for c in circles})
        self.assertAlmostEqual(ys[1]-ys[0],.98*1.5*500)
        xs=sorted(c.x for c in circles if c.y==ys[len(ys)//2])
        self.assertAlmostEqual(xs[1]-xs[0],.98*math.sqrt(3)*500)
    def test_projection_and_geodesic_radius_safety(self):
        from pyproj import Geod
        from shapely.geometry import Point
        geod=Geod(ellps='WGS84')
        for lon,lat in [(44,25),(44,40),(54,32),(63,25),(63,40),(46.298114433,38.075792663)]:
            p=project([Point(lon,lat)])[0];a,b=wgs84(p.x,p.y)
            self.assertAlmostEqual(a,lat,7);self.assertAlmostEqual(b,lon,7)
            footprint=Circle('safety',p.x,p.y,3000).footprint()
            for x,y in footprint.exterior.coords:
                ylat,xlon=wgs84(x,y);_,_,distance=geod.inv(lon,lat,xlon,ylat)
                self.assertLessEqual(distance,3000)
    def test_reject_invalid_target_and_unbounded_batch(self):
        with self.assertRaises(ValueError):cover(box(0,0,10000,10000),50,max_candidates=5)


class NearbyPaginationGuardTests(unittest.TestCase):
    def test_unexpected_continuation_fails_closed(self):
        from backend.poi_provider import nearby_items
        for container in ('root','layer'):
            body={'layerPoints':{'nearestPoints':[]}}
            target=body if container=='root' else body['layerPoints']
            target['nextPageToken']='not-persisted'
            with self.assertRaisesRegex(ValueError,'pagination'):nearby_items(body)
        self.assertEqual(nearby_items({'has_more':False,'layerPoints':{'nearestPoints':[]}}),[])
