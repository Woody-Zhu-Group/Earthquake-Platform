import numpy as np
from scipy.spatial.distance import cdist
from tqdm import tqdm
from .score import ScoreModel

# No need to change the detector

class SpatioTemporalDetector():
    '''
    Spatio (2d) * temporal (1d) change detection
    By default assume space is [0, 1] * [0, 1]
    '''
    def __init__(self, f0:ScoreModel, f1:ScoreModel):
        '''both are trained score models'''
        self.f0 = f0    # pre-change score model
        self.f1 = f1    # post-change score model

    def offline(self, data, ntt=50, K=5, verbose=True,
                nres=20, radius=0.1, use_grid=True):
        '''
        Args:
        - data:     [ ndata, ndim ] np, raw data
        - ntt:      number of time grids
        - K:        number of inner-outer iterations
        - nres:     resolution for change region grid (if using grid-based optimization)
        - radius:   radius for change region (if using event-based optimization)
        - use_grid: type of inner optimization used, 'grid' or 'event'
        '''
        measure = self.f0.psi(data) - self.f1.psi(data) # [ ndata ] np, anomaly measures
        tt = np.linspace(data[:, 0].min(), data[:, 0].max() + 1e-5, ntt)  # [ ntt ] np
        tau_list, omega_list, stat_list = [], [], []
        tau = 0  # initialize values
        radius = 1/(2*(nres-1)) if use_grid else radius  # radius of each grid cell
        for i in tqdm(range(len(tt)), desc='Offline') if verbose else range(len(tt)):
            t = tt[i]
            for _ in range(K):
                omega       = self.inner_grid(data, measure, tau, nres, t) if use_grid else self.inner_event(data, measure, tau, t)
                tau, stat   = self.outer(data, measure, omega, radius, t)
            tau_list.append(tau)
            omega_list.append(omega)
            stat_list.append(stat)
        return tt, tau_list, omega_list, stat_list, measure

    def online(self, data, ntt=50, K=5, n_update=10, window=None, fit_kwds={}, verbose=True,
               nres=20, radius=0.1, use_grid=True):
        '''
        online detection
        Args:
        - data:     [ ndata, ndim ] np, raw data (post change)
        - ntt:      number of time grids
        - K:        number of inner-outer iterations
        - n_update: number of model updates
        - window:   window size of past data length used for model updates
        - nres:     resolution for change region grid (if using grid-based optimization)
        - radius:   radius for change region (if using event-based optimization)
        - use_grid: type of inner optimization used, 'grid' or 'event'
        '''        
        # init hyperparameters
        tt = np.linspace(data[:, 0].min(), data[:, 0].max() + 1e-5, ntt)  # [ ntt ] np
        tau_list, omega_list, stat_list = [], [], []
        tau = 0.  # initialize values
        measure = self.f0.psi(data) - self.f1.psi(data) # [ ndata ] np, anomaly measures placeholder

        # dynamically update s1 and compute anomaly measures
        skip    = ntt // n_update if n_update is not None else 1
        window  = skip if window is None else window
        radius = 1/(2*(nres-1)) if use_grid else radius  # radius of each grid cell

        for i in tqdm(range(len(tt)), desc='Online') if verbose else range(len(tt)):
            # update change point and region estimates
            t = tt[i]
            for _ in range(K):
                omega       = self.inner_grid(data, measure, tau, nres, t) if use_grid else self.inner_event(data, measure, tau, t)
                tau, stat   = self.outer(data, measure, omega, radius, t)
            tau_list.append(tau)
            omega_list.append(omega)
            stat_list.append(stat)

            # update model sometimes
            if i % skip == 0 and i != 0:
                mask_old = (data[:, 0] >= tt[max(i-max(skip, window), 0)]) & (data[:, 0] < tt[i])    # [ ndata ] np, mask for previous batch
                mask_new = (data[:, 0] >= tt[i]) & (data[:, 0] < tt[min(i + skip, len(tt)-1)])       # [ ndata ] np, mask for current batch
                # fit and update anomaly measure
                mask_s = cdist(data[:, 1:3], omega, metric='chebyshev') < radius # [ ndata, n_omega ] np
                mask_s = mask_s.any(1)              # [ ndata ] np, mask for data in omega
                mask_t = data[:, 0] >= tau          # [ ndata ] np, mask for data in [tau, T)
                mask   = mask_old & mask_s & mask_t # [ ndata ] bp, mask for data in previous batch & omega & [tau, T)
                if mask.sum() == 0:
                    mask = mask_old # fall back to fitting with all previous batch contents
                self.f1.fit(data[mask], **fit_kwds)   # update model
                measure[mask_new] = (self.f0.psi(data) - self.f1.psi(data))[mask_new]
        return tt, tau_list, omega_list, stat_list, measure
    
    @staticmethod
    def inner_grid(data, measure, tau, nres, t):
        '''
        inner optimization: estimate change region "omega"
        Args:
        - data:     [ ndata, 3 ] np, full catalogs spanning [0, T)
        - measure:  [ ndata ] np, anomaly measures
        - tau:      scalar
        '''
        # select data in [tau, t)
        mask1   = data[:, 0] >= tau     # [ ndata ] np, indicator for all data in [tau, T)
        mask2   = data[:, 0] < t        # [ ndata ] np, indicator for all data in [0, t)
        mask    = mask1 & mask2         # [ ndata ] np, indicator for all data in [tau, t)
        coords  = data[:, 1:3][mask]    # [ ncoords, 2 ] np
        # get omega
        points  = SpatioTemporalDetector.generate_gridded_points(nres)   # [ nres**2, 2 ] np
        mat     = cdist(points, coords, metric='chebyshev')  # [ nres**2, ncoords ] np
        mask1   = mat < 1/(2 * (nres - 1))      # [ nres**2, ncoords ] np
        val     = mask1 @ measure[mask]         # [ nres**2 ] np
        omega   = points[val > 1e-5]            # [ nomega, 2 ] np
        return omega # [ nomega, 2 ] np
    
    @staticmethod
    def inner_event(data, measure, tau, t):
        '''
        inner optimization: estimate change region "omega"
        Args:
        - data:     [ ndata, 3 ] np, full catalogs spanning [0, T)
        - measure:  [ ndata ] np, anomaly measures
        - tau:      scalar
        '''
        # select data in [tau, t)
        mask1   = data[:, 0] >= tau     # [ ndata ] np, indicator for all data in [tau, T)
        mask2   = data[:, 0] < t        # [ ndata ] np, indicator for all data in [0, t)
        mask3   = measure > 1e-5        # [ ndata ] np, indicator for all data with non-negligible measure
        mask    = mask1 & mask2 & mask3 # [ ndata ] np, indicator for all data in [tau, t) with non-negligible measure
        omega   = data[:, 1:3][mask]    # [ ncoords, 2 ] np
        return omega # [ nomega, 2 ] np

    @staticmethod
    def outer(data, measure, omega, radius, t):
        '''
        outer optimization: estimate change point "tau"
        Args:
        - data:     [ ndata, 3 ] np, full catalogs spanning [0, T)
        - measure:  [ ndata ] np, anomaly measures
        '''
        # select data in [0, t)*omega  
        mat     = cdist(data[:, 1:3], omega, metric='chebyshev')    # [ ndata, nomega ]
        mask1   = (mat < radius).any(1)                 # [ ndata ], indicator for all data in omega
        mask2   = data[:, 0] < t                                    # [ ndata ] np, indicator for all data in [0, t)
        mask    = mask1 & mask2                                     # [ ndata ] np, indicator for all data in [0, t)*omega
        # get tau
        if mask.sum() > 0:
            i = SpatioTemporalDetector.arg_cusum(measure[mask])
            stat = SpatioTemporalDetector.cusum(measure[mask])
            tau = data[:, 0][mask][i]
        else:
            tau  = t
            stat = 0
        return tau, stat

    @staticmethod
    def generate_gridded_points(nres):
        x = np.linspace(0, 1, nres)
        y = np.linspace(0, 1, nres)
        xv, yv = np.meshgrid(x, y)
        points = np.stack([xv.ravel(), yv.ravel()], axis=-1)
        return points   # [ nres**2, 2 ] np
    
    @staticmethod
    def cusum(arr):
        '''arr: [ narr ] np, array'''
        arr     = np.cumsum(arr[::-1])[::-1] # [ narr ] np
        V       = arr.max()
        return V    # scalar

    @staticmethod
    def arg_cusum(arr):
        '''arr: [ narr ] np, array'''
        arr     = np.cumsum(arr[::-1])[::-1] # [ narr ] np
        i       = arr.argmax()
        return i    # scalar
    
    def calibrate(self, arl, data_cal, ntt=50, K=5, verbose=False,
                  nres=20, radius=0.1, use_grid=True):
        '''
        Args:
        - arl:        desired ARL
        - data_cal:   ragged list of [ ndata, ndim ] np, calibration data (pre-change)
        '''
        pbar = tqdm(data_cal, desc='Calibrating') if verbose else data_cal
        W_list = []
        for data in pbar:
            _, _, _, stat_list, _ = self.offline(data, ntt=ntt, K=K, verbose=False, nres=nres, radius=radius, use_grid=use_grid)
            W = np.max(stat_list)  # scalar
            W_list.append(W)
        W_arr = np.array(W_list)    # [ cal_size ] np
        threshold = np.quantile(W_arr, np.exp(-len(stat_list)/arl))   # scalar
        return threshold
    
    def stopping_time_and_region(self, data, threshold=None, ntt=50, K=5,
                  nres=20, radius=0.1, use_grid=True):
        '''
        Args:
        - data:     [ ndata, ndim ] np, testing data
        Returns:
        - time:     stopping time scalar
        - region:   [ 2 ] np
        '''
        tt, _, omega_list, stat_list, _ = self.offline(data, ntt=ntt, K=K, verbose=False, nres=nres, radius=radius, use_grid=use_grid)
        mask = np.asarray(stat_list) >= threshold   # (list >= float raised TypeError)
        if np.any(mask):
            index = np.argmax(mask)
        else:
            index = len(stat_list) - 1 # default let the stopping time to be the end of the sequence
        return tt[index], omega_list[index]